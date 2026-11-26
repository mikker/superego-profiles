// The vault, as the daemon sees it: notes, their [[links]] and backlinks. A thread's vault is its folder when that's an
// Obsidian vault (it has `.obsidian/`), else the one set in Settings (`vault.path`), else its folder as it is. Gives the
// UI two methods (vault.graph, vault.note) and a live list of the set vault's notes (vault.list), the agent two tools
// (search_notes, backlinks) and a prompt section with the vault's own AGENTS.md. New threads that don't start in a
// vault start in the set one.
import { statSync, watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { defineDaemonExtension, defineExtension, defineTool, int, obj, opt, RpcError, section, str } from 'superego'
import { about, LIST, SETTING, type Graph, type NoteInfo, type VaultList } from './shared.ts'

type Note = { path: string; title: string; folder: string; links: string[]; text: string; aliases: string[]; at: number }

const SKIP = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.agents', '.superego'])

/** Every Markdown note under `root`, with the [[links]] and ![[embeds]] it makes (targets as written). */
async function scan(root: string): Promise<Note[]> {
  const notes: Note[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.md')) {
        const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
        const links = [...text.matchAll(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!.trim())
        const rel = relative(root, path)
        notes.push({ path: rel, title: basename(rel, '.md'), folder: rel.includes('/') ? rel.split('/')[0]! : '', links, text, aliases: aliasesOf(text), at: info.mtimeMs })
      }
    }
  }
  await walk(root)
  // By path, whatever order the disk lists them in: the same answers each time.
  return notes.sort((a, b) => a.path.localeCompare(b.path))
}

const isFolder = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }

/** Whether a folder is an Obsidian vault: it has the `.obsidian/` folder Obsidian keeps its settings in. */
export const isVault = (dir: string) => isFolder(join(dir, '.obsidian'))

/**
 * A vault folder as set (`~/` for the home folder): where it is, or why it won't do (`problem`), or why it may not be
 * a vault though it reads (`warning`).
 */
export function checkVault(setting: string): { root: string; problem?: string; warning?: string } {
  const asked = setting.trim()
  const root = asked === '~' ? homedir() : asked.startsWith('~/') ? join(homedir(), asked.slice(2)) : asked
  if (!isAbsolute(root)) return { root, problem: `${asked} isn't a full path: start it with / or ~/` }
  const at = resolve(root)
  if (!isFolder(at)) return { root: at, problem: `There's no folder at ${asked}` }
  if (!isVault(at)) return { root: at, warning: `${asked} has no .obsidian folder: it may not be an Obsidian vault` }
  return { root: at }
}

/** A note's `aliases` (or `alias`) in its frontmatter: a list, `[a, b]`, or one. */
function aliasesOf(text: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (!front) return []
  const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  const at = /^alias(?:es)?:[ \t]*(.*)$/m.exec(front)
  if (!at) return []
  const inline = at[1]!.trim()
  if (inline) return (inline.startsWith('[') ? inline.slice(1, -1).split(',') : [inline]).map(unquote).filter(Boolean)
  const after = front.slice(at.index + at[0].length).split(/\r?\n/).slice(1)
  const items: string[] = []
  for (const line of after) { const item = /^\s*-\s+(.*)$/.exec(line); if (!item) break; items.push(unquote(item[1]!)) }
  return items.filter(Boolean)
}

/**
 * Resolve a [[target]] as Obsidian does: a path if it has one, else the note of that name anywhere in the vault
 * (shortest path wins), else the note with that alias.
 */
function resolver(notes: Note[]) {
  const byPath = new Map(notes.map((n) => [n.path.toLowerCase(), n]))
  const byName = new Map<string, Note>()
  const byAlias = new Map<string, Note>()
  for (const note of [...notes].sort((a, b) => a.path.length - b.path.length)) {
    if (!byName.has(note.title.toLowerCase())) byName.set(note.title.toLowerCase(), note)
    for (const alias of note.aliases) if (!byAlias.has(alias.toLowerCase())) byAlias.set(alias.toLowerCase(), note)
  }
  return (target: string) => {
    const t = target.trim().toLowerCase().replace(/\.md$/, '')
    return byPath.get(`${t}.md`) ?? byName.get(t.split('/').at(-1)!) ?? byAlias.get(t)
  }
}

/** The line (1-based) of a note's `heading` (as Obsidian matches it: its words, any level) or `^block`; else none. */
function lineOf(text: string, { heading, block }: { heading?: string; block?: string }) {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const lines = text.split(/\r?\n/)
  // [[Note#A#B]]: the last heading named.
  const wanted = heading && words(heading.split('#').at(-1)!)
  const at = lines.findIndex((line) => wanted ? /^#{1,6}\s/.test(line) && words(line.replace(/^#+\s*/, '')) === wanted
    : block ? new RegExp(`\\s\\^${block.replace(/[^\w-]/g, '')}\\s*$`).test(line) : false)
  return at >= 0 ? at + 1 : undefined
}

/** The notes that link to `note`. */
const backlinksOf = (notes: Note[], resolve: ReturnType<typeof resolver>, note: Note) =>
  notes.filter((n) => n !== note && n.links.some((l) => resolve(l) === note))

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    /** A short cache: the graph pane and the tools ask often; a vault changes slowly. */
    const cache = new Map<string, { at: number; notes: Promise<Note[]> }>()
    const notesOf = (root: string) => {
      const hit = cache.get(root)
      if (hit && Date.now() - hit.at < 5_000) return hit.notes
      const notes = scan(root)
      cache.set(root, { at: Date.now(), notes })
      return notes
    }

    superego.settings.register({
      id: 'vault', title: 'Obsidian vault',
      description: 'The vault the obsidian profile works on: its Vault space, and threads not started inside a vault.',
      settings: [{
        key: SETTING, title: 'Vault folder', description: 'The folder Obsidian opens: the one with the .obsidian folder in it.',
        type: { type: 'string', placeholder: '~/Documents/Vault' }, default: '',
        validate: (value) => (typeof value === 'string' && value.trim() ? checkVault(value).problem : undefined),
      }],
    })
    /** The vault set in Settings, if one is and it reads; else undefined. */
    const configured = () => {
      const setting = superego.settings.get<string>(SETTING)?.trim()
      if (!setting) return undefined
      const vault = checkVault(setting)
      return vault.problem ? undefined : vault.root
    }
    /** A folder's vault: itself if it's a vault, else the one set, else itself (as it always was). */
    const vaultOf = (cwd: string) => (isVault(cwd) ? cwd : configured() ?? cwd)
    /** The vault a call is about: its thread's, or with no thread (the space) the one set. */
    const rootOf = async (thread: string | undefined) => {
      const root = thread ? vaultOf((await superego.threads.get(thread)).cwd) : configured()
      if (!root) throw new RpcError('not_found', 'No vault is set: choose its folder in Settings → Obsidian vault')
      return root
    }
    /** The vault of the thread an agent's call is in. */
    const rootOfCall = (conversationId: number) => rootOf(superego.threads.of(conversationId)!)
    const notesOfCall = async (conversationId: number) => notesOf(await rootOfCall(conversationId))

    // A thread that doesn't start in a vault starts in the one set, so its files, panes and AGENTS.md are the vault's.
    superego.thread({
      starting(draft) {
        if (isVault(draft.cwd)) return
        const root = configured()
        if (root && root !== draft.cwd) return { cwd: root }
      },
    })

    // The set vault's notes, newest first, for its space: read again whenever a note (or a folder of them) changes.
    const list = superego.value<VaultList>(LIST, { root: null, notes: [] })
    let watching: { root: string; stop: AbortController } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = 0
    const publish = async () => {
      const setting = superego.settings.get<string>(SETTING)?.trim()
      if (!setting) return list.set({ root: null, notes: [] })
      const { root, problem, warning } = checkVault(setting)
      if (problem) return list.set({ root, problem, notes: [] })
      const mine = ++reading
      cache.delete(root)
      try {
        const notes = (await notesOf(root)).map(({ path, title, folder, at }) => ({ path, title, folder, at }))
        if (mine !== reading || superego.signal.aborted) return
        list.set({ root, ...(warning ? { warning } : {}), notes: notes.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path)) })
      } catch (error) {
        if (mine === reading) list.set({ root, problem: `Couldn't read ${setting}: ${(error as Error).message}`, notes: [] })
      }
    }
    const publishSoon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void publish(), 150)
    }
    /** Watch the set vault (and only it): a note added, changed, moved or gone. Obsidian's own files don't count. */
    let followed: string | undefined
    const follow = () => {
      // Any setting changing calls this: only the vault's matters.
      const setting = superego.settings.get<string>(SETTING)?.trim() ?? ''
      if (setting === followed) return
      followed = setting
      const vault = setting ? checkVault(setting) : undefined
      const root = vault && !vault.problem ? vault.root : undefined
      if (watching?.root === root) return
      watching?.stop.abort()
      watching = undefined
      if (root) {
        const stop = new AbortController()
        superego.signal.addEventListener('abort', () => stop.abort(), { once: true })
        try {
          watch(root, { recursive: true, signal: stop.signal }, (_event, file) => {
            const name = file?.toString()
            if (!name || (!name.split('/').some((part) => part.startsWith('.')) && (name.endsWith('.md') || !/\.[^/]+$/.test(name)))) publishSoon()
          }).on('error', (error) => { console.error('[vault] watching the vault failed:', error); publishSoon() })
          watching = { root, stop }
        } catch (error) {
          console.error('[vault] watching the vault failed; its list updates only when the setting changes:', error)
        }
      }
      void publish()
    }
    superego.settings.onChange(follow)
    follow()

    superego.method('vault.graph', async ({ thread }): Promise<Graph> => {
      const notes = await notesOf(await rootOf(thread))
      const resolve = resolver(notes)
      const edges: Graph['edges'] = []
      const seen = new Set<string>()
      for (const note of notes) {
        for (const target of note.links) {
          const to = resolve(target)
          if (!to || to === note) continue
          const key = `${note.path}\0${to.path}`
          if (!seen.has(key)) { seen.add(key); edges.push({ from: note.path, to: to.path }) }
        }
      }
      return { nodes: notes.map((n) => ({ id: n.path, title: n.title, folder: n.folder })), edges }
    }, { params: obj({ thread: opt(str()) }) })

    // `path`: a path or a [[target]]; `heading` or `block` (a [[Note#Heading]]'s, a [[Note#^block]]'s): its line too.
    superego.method('vault.note', async ({ thread, path, heading, block }): Promise<NoteInfo> => {
      const root = await rootOf(thread)
      const notes = await notesOf(root)
      const resolve = resolver(notes)
      const note = resolve(path)
      if (!note) throw new RpcError('not_found', `No note ${path}`)
      const backlinks = backlinksOf(notes, resolve, note).map((n) => ({ path: n.path, title: n.title }))
      const line = heading || block ? lineOf(note.text, { ...(heading ? { heading } : {}), ...(block ? { block } : {}) }) : undefined
      return { path: note.path, title: note.title, content: note.text, backlinks, ...(line ? { line } : {}), root }
    }, { params: obj({ thread: opt(str()), path: str(), heading: opt(str()), block: opt(str()) }) })

    superego.agent(defineExtension({
      name: 'vault',
      // Where the vault is, if not the thread's folder, and its own rules, as they are now, on every turn.
      sections: [section('vault', async ({ agent }) => {
        if (!agent.cwd) return undefined
        const root = vaultOf(agent.cwd)
        const where = root === agent.cwd ? '' : `The vault is ${root}, not your folder (${agent.cwd}): give the file tools its notes' full paths.`
        const rules = await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => '')
        return [where, rules && `The vault's AGENTS.md (its rules for agents; follow them):\n\n${rules}`].filter(Boolean).join('\n\n') || undefined
      })],
      tools: [
        defineTool({
          name: 'search_notes',
          description: 'Find notes in the vault whose title or text contains all the words of the query (case-insensitive). Returns paths and a line of context, best first (title matches).',
          parameters: obj({ query: str({ minLength: 1 }), limit: opt(int({ minimum: 1, maximum: 100, description: 'how many at most (20)' })) }),
          async execute({ query, limit }, api) {
            const notes = await notesOfCall(api.conversationId)
            const words = query.toLowerCase().split(/\s+/).filter(Boolean)
            const hits = notes
              .map((n) => ({ n, score: words.every((w) => `${n.title}\n${n.text}`.toLowerCase().includes(w)) ? words.filter((w) => n.title.toLowerCase().includes(w)).length * 10 + 1 : 0 }))
              .filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit ?? 20)
            const line = (n: Note) => n.text.split('\n').find((l) => words.some((w) => l.toLowerCase().includes(w)))?.trim().slice(0, 140) ?? ''
            return text(hits.length ? hits.map(({ n }) => `${n.path} — ${line(n)}`).join('\n') : 'No notes match.')
          },
        }),
        defineTool({
          name: 'backlinks',
          description: 'The notes that link to a note ([[Note]] or [[path/Note]]), by path.',
          parameters: obj({ note: str({ minLength: 1 }) }),
          async execute({ note: target }, api) {
            const notes = await notesOfCall(api.conversationId)
            const resolve = resolver(notes)
            const note = resolve(target)
            if (!note) return text(`No note ${target}.`)
            const from = backlinksOf(notes, resolve, note).map((n) => n.path)
            return text(from.length ? from.join('\n') : `Nothing links to ${note.path}.`)
          },
        }),
      ],
    }))

    return () => {
      clearTimeout(timer)
      watching?.stop.abort()
    }
  },
})
