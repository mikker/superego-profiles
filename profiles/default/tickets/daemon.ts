// tickets, daemon half: a folder's tk tickets (`.tickets`, from the thread's folder up to the repository root), read
// straight from the files and kept in memory, watched so they're current. Each folder's counts are a live value scoped
// by the folder; the pane reads lists and tickets with methods; the agent has read-only tools where there's a
// `.tickets`. Writing stays tk's: an action here would run the `tk` CLI in the folder, and the watcher picks up its
// change like any other.
import {
  defineAction, defineDaemonExtension, defineExtension, defineTool, int, lit, obj, opt, str, section, union, RpcError,
} from 'superego'
import { findTicketsDir, TicketIndex, watchDir } from './index.ts'
import { formatRow, formatTicket, parseQuery, refOf, resolve, rowOf, search, type Filters } from './tickets.ts'
import { about, NO_TICKETS, PANE, STATE, type FolderState, type ListResult, type ShowResult } from './shared.ts'

/** How long the folder has to be still before it's read again: tk writes a ticket in a few steps. */
export const DEBOUNCE = 150

type Watched = { index: TicketIndex; folders: Set<string>; stop: () => void; ready: Promise<void> }

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const state = superego.scopedValue<FolderState>(STATE, NO_TICKETS)
    /** Each `.tickets` folder read, by its path. */
    const watched = new Map<string, Watched>()
    /** Each folder asked about, and the `.tickets` it reads (null: none). */
    const dirOf = new Map<string, string | null>()

    function publish(w: Watched) {
      if (superego.signal.aborted) return
      const next = { dir: w.index.dir, version: w.index.version, counts: w.index.counts }
      for (const folder of w.folders) state.set(folder, next)
    }

    function forget(dir: string) {
      const w = watched.get(dir)
      if (!w) return
      w.stop()
      watched.delete(dir)
      // Its folders look again: it may be back, or another above it may do.
      for (const folder of w.folders) { dirOf.delete(folder); void look(folder).catch(() => {}) }
    }

    function watchOf(dir: string): Watched {
      let w = watched.get(dir)
      if (w) return w
      const index = new TicketIndex(dir)
      const refresh = () => index.refresh().then((changed) => { if (changed && watched.get(dir) === w) publish(w!) }, () => forget(dir))
      const stop = watchDir(dir, { debounce: DEBOUNCE, signal: superego.signal, onChange: () => void refresh(), onGone: () => forget(dir) })
      w = { index, folders: new Set(), stop, ready: refresh() }
      watched.set(dir, w)
      return w
    }

    /**
     * The `.tickets` a folder reads, found again (one may have been made or removed since), read and watched; its state
     * published. Undefined when it has none.
     */
    async function look(folder: string): Promise<Watched | undefined> {
      const dir = (await findTicketsDir(folder)) ?? null
      if (superego.signal.aborted) return undefined
      const before = dirOf.get(folder)
      if (before && before !== dir) {
        const old = watched.get(before)
        old?.folders.delete(folder)
        if (old && !old.folders.size) { old.stop(); watched.delete(before) }
      }
      dirOf.set(folder, dir)
      if (!dir) {
        if (superego.signal.aborted) return undefined
        if (state.get(folder).dir !== null || before === undefined) state.set(folder, NO_TICKETS)
        return undefined
      }
      const w = watchOf(dir)
      w.folders.add(folder)
      await w.ready
      if (superego.signal.aborted) return undefined
      if (watched.get(dir) !== w) return look(folder)
      const s = state.get(folder)
      if (s.dir !== dir || s.version !== w.index.version) publish(w)
      return w
    }

    /** The folder's tickets, or an error saying it has none. */
    async function need(folder: string): Promise<Watched> {
      const w = await look(folder)
      if (!w) throw new RpcError('not_found', `No .tickets folder in ${folder} or above it (up to the repository root).`, { hint: 'tk create makes one.' })
      return w
    }

    function list(w: Watched, filters: Filters & { query?: string; limit?: number }): ListResult {
      const query = { ...parseQuery(filters.query ?? ''), ...definedOf(filters) }
      const found = search(w.index.byId.values(), query)
      const limit = filters.limit ?? 200
      return {
        dir: w.index.dir, total: found.length, counts: w.index.counts,
        rows: found.slice(0, limit).map((t) => rowOf(t, w.index.byId)),
      }
    }

    function show(w: Watched, id: string): ShowResult {
      const { byId } = w.index
      let ticket
      try { ticket = resolve(byId, id) } catch (error) { throw new RpcError('invalid_params', (error as Error).message) }
      if (!ticket) throw new RpcError('not_found', `No ticket ${id} in ${w.index.dir}.`)
      const children = [...byId.values()].filter((t) => t.parent === ticket.id).map((t) => refOf(t.id, byId))
      return {
        ticket,
        deps: ticket.deps.map((d) => refOf(d, byId)),
        links: ticket.links.map((d) => refOf(d, byId)),
        ...(ticket.parent ? { parent: refOf(ticket.parent, byId) } : {}),
        children,
      }
    }

    // ── Reads for the window, and the action that opens the pane ───────────────────────────────────────────────────

    const statusFilter = union([lit('open'), lit('closed'), lit('all'), lit('in_progress')])

    superego.method('tickets.state', async ({ folder }) => { await look(folder); return state.get(folder) }, { params: obj({ folder: str() }) })
    superego.method('tickets.list', async ({ folder, ...filters }) => list(await need(folder), filters), {
      params: obj({ folder: str(), status: opt(statusFilter), query: opt(str()), limit: opt(int({ minimum: 1 })) }),
    })
    superego.method('tickets.show', async ({ folder, id }) => show(await need(folder), id), { params: obj({ folder: str(), id: str({ minLength: 1 }) }) })

    superego.action(defineAction({
      id: 'tickets.open', title: 'Show tickets', description: "Open this folder's tk tickets beside the thread.",
      expose: ['ui', 'cli'], thread: true,
      params: obj({
        thread: opt(str()),
        id: opt(str({ description: 'a ticket to show' })),
        query: opt(str({ description: 'a search: words, type:bug, #tag, p1' })),
        status: opt(union([lit('open'), lit('closed'), lit('all')])),
      }),
      // The thread's tickets pane, if it has one, shows what's asked (and comes to the front); else one opens.
      run: async ({ thread, ...asked }) => {
        if (!thread) throw new RpcError('invalid_params', 'Say which thread (--thread).')
        const params = Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined && v !== ''))
        const pane = (await superego.threads.get(thread)).panes?.find((p) => p.kind === PANE)
        if (!pane) return superego.dispatch('pane.open', { thread, kind: PANE, ...(Object.keys(params).length ? { params } : {}) })
        if (Object.keys(params).length) await superego.dispatch('pane.update', { thread, pane: pane.id, params })
        return superego.dispatch('pane.focus', { thread, pane: pane.id })
      },
    }))

    // ── The agent: read-only tools, where the folder has tickets ───────────────────────────────────────────────────

    const folderOfCall = (api: { conversationId: Parameters<typeof superego.threads.of>[0]; env?: { cwd?: string } }) =>
      api.env?.cwd ?? superego.threads.get(superego.threads.of(api.conversationId)!).then((t) => t.cwd)
    const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
    const toolNeed = async (folder: string) => {
      try { return await need(folder) } catch (error) { throw new Error((error as Error).message) }
    }

    const part = defineExtension({
      name: 'tickets',
      tools: [
        defineTool({
          name: 'tickets_search',
          description: "Search this project's tk tickets (.tickets). Returns one line per ticket: id, status, priority (0 highest), type, title, [tags]; best matches first, then by priority and recency. Read one in full with tickets_show.",
          parameters: obj({
            query: opt(str({ description: 'words to find in the id, title, tags and body (all must match). Empty: every ticket the filters allow' })),
            status: opt(union([lit('open'), lit('in_progress'), lit('closed'), lit('all')], { description: 'open (default: open and in_progress), in_progress, closed, or all' })),
            type: opt(str({ description: 'bug, feature, task, epic or chore' })),
            priority: opt(int({ minimum: 0, maximum: 4, description: 'exactly this priority' })),
            tag: opt(str()),
            assignee: opt(str({ description: 'part of the name' })),
            parent: opt(str({ description: "a parent ticket's id: its children" })),
            limit: opt(int({ minimum: 1, maximum: 500, description: 'at most this many (30)' })),
          }),
          async execute({ query, limit, ...filters }, api) {
            const w = await toolNeed(await folderOfCall(api))
            const status = filters.status ?? (parseQuery(query ?? '').status ? undefined : 'open')
            const result = list(w, { ...filters, status, query, limit: limit ?? 30 })
            const { counts } = result
            const head = `${result.total} found in ${w.index.dir} (${counts.open} open, ${counts.in_progress} in progress, ${counts.closed} closed)`
            const more = result.total > result.rows.length ? `\n… ${result.total - result.rows.length} more (raise limit, or narrow the query)` : ''
            return text(`${head}\n${result.rows.map(formatRow).join('\n')}${more}`)
          },
        }),
        defineTool({
          name: 'tickets_show',
          description: 'One tk ticket in full: its fields, the tickets it depends on, links to, its parent and children (with their status and title), then its Markdown body.',
          parameters: obj({ id: str({ minLength: 1, description: "its id, or a unique part of it (as tk takes)" }) }),
          async execute({ id }, api) {
            const w = await toolNeed(await folderOfCall(api))
            let result
            try { result = show(w, id) } catch (error) { throw new Error((error as Error).message) }
            const { ticket, ...refs } = result
            return text(formatTicket(ticket, refs, `${w.index.dir}/${ticket.file}`))
          },
        }),
      ],
      sections: [section('tickets', ({ env }) => {
        const dir = env?.cwd ? dirOf.get(env.cwd) : undefined
        return dir
          ? `This project tracks work as tk tickets in ${dir}. Read them with tickets_search and tickets_show; create, start, close or change them only with the \`tk\` CLI (\`tk help\`), not by editing the files.`
          : undefined
      })],
    })
    superego.agent(part, { always: false })
    // Only threads whose folder has tickets get the tools and the line about them.
    superego.agentParts(async ({ id }) => {
      const { cwd } = await superego.threads.get(id)
      return (await look(cwd)) ? [part] : undefined
    })

    // A thread starting in a folder looks: its window's pill is right without waiting for the window to ask.
    superego.thread({ started(thread) { void look(thread.cwd).catch(() => {}) } })

    return () => { for (const w of watched.values()) w.stop() }
  },
})

/** Just the filters given, so they don't override what the query text says with undefined. */
function definedOf(filters: Filters & { query?: string; limit?: number }): Filters {
  const out: Filters = {}
  for (const key of ['status', 'type', 'priority', 'tag', 'assignee', 'parent'] as const) {
    if (filters[key] !== undefined) (out as Record<string, unknown>)[key] = filters[key]
  }
  return out
}
