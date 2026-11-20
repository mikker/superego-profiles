// tickets, tested as it runs: parsing on its own, then a real daemon with this profile reading throwaway `.tickets`
// folders, watching them change, and the agent's tools. Run with `superego extension test tickets` in this profile.
import { mkdtemp, mkdir, rm, writeFile, unlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { callTool, say, testDaemon, type TestDaemon } from 'superego/testing'
import { findTicketsDir, TicketIndex } from './index.ts'
import { formatRow, parseQuery, parseTicket, resolve, rowOf, search } from './tickets.ts'
import { STATE, type FolderState, type ListResult, type ShowResult, type Ticket } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname

let daemon: TestDaemon | undefined
const folders: string[] = []
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

async function tempFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'tickets-test-'))
  folders.push(folder)
  return folder
}

type Spec = { id: string; title?: string; status?: string; type?: string; priority?: number; deps?: string[]; links?: string[]; tags?: string[]; parent?: string; body?: string }
const fileOf = (t: Spec) => [
  '---', `id: ${t.id}`, `status: ${t.status ?? 'open'}`, `deps: [${(t.deps ?? []).join(', ')}]`, `links: [${(t.links ?? []).join(', ')}]`,
  'created: 2026-01-01T00:00:00Z', `type: ${t.type ?? 'task'}`, `priority: ${t.priority ?? 2}`,
  ...(t.parent ? [`parent: ${t.parent}`] : []), ...(t.tags ? [`tags: [${t.tags.join(', ')}]`] : []),
  '---', `# ${t.title ?? `Ticket ${t.id}`}`, '', t.body ?? '', '',
].join('\n')

/** A project (a git repository) with `.tickets` holding these, written oldest first so later ones are more recent. */
async function project(tickets: Spec[]) {
  const root = await tempFolder()
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.tickets'))
  for (const [i, t] of tickets.entries()) {
    const path = join(root, '.tickets', `${t.id}.md`)
    await writeFile(path, fileOf(t))
    const at = new Date(Date.UTC(2026, 0, 1, 0, i))
    const { utimes } = await import('node:fs/promises')
    await utimes(path, at, at)
  }
  return root
}

const ticket = (text: string, file = 'ab-12.md') => parseTicket(text, file, 1)

describe('parsing', () => {
  it('reads what tk writes', () => {
    const t = ticket(fileOf({ id: 'ab-12', title: 'Fix it', type: 'bug', priority: 1, deps: ['ab-1'], tags: ['ui', 'core'], parent: 'ab-0', body: 'Why.\n\n## Notes\n\nmore' }))
    expect(t).toMatchObject({
      id: 'ab-12', title: 'Fix it', status: 'open', type: 'bug', priority: 1, deps: ['ab-1'], links: [], tags: ['ui', 'core'],
      parent: 'ab-0', created: '2026-01-01T00:00:00Z', body: 'Why.\n\n## Notes\n\nmore', extra: {},
    })
  })

  it('takes CRLF, a BOM, quotes, block lists, bare lists and odd priorities', () => {
    const t = ticket('\uFEFF---\r\nid: "ab-3"\r\nstatus: In-Progress\r\ntags:\r\n  - one\r\n  - "two, three"\r\ndeps: ab-1, ab-2\r\nlinks:\r\npriority: P0\r\nassignee: \'Ann O\'\'Neil\'\r\nexternal-ref: gh-12\r\nsummary: kept\r\n---\r\n\r\n# Title here \r\nbody\r\n')
    expect(t).toMatchObject({
      id: 'ab-3', status: 'in_progress', tags: ['one', 'two, three'], deps: ['ab-1', 'ab-2'], links: [], priority: 0,
      assignee: "Ann O'Neil", externalRef: 'gh-12', extra: { summary: 'kept' }, title: 'Title here', body: 'body',
    })
    expect(ticket('---\npriority: 9\n---\n# x').priority).toBe(4)
    expect(ticket('---\npriority: soon\n---\n# x').priority).toBe(2)
    expect(ticket('---\npriority: -1\n---\n# x').priority).toBe(0)
  })

  it('falls back to the file name, a title field, and defaults', () => {
    expect(ticket('Just text, no frontmatter.\n# Not a title: text came first', 'zz-9.md'))
      .toMatchObject({ id: 'zz-9', title: 'zz-9', status: 'open', type: 'task', priority: 2, body: 'Just text, no frontmatter.\n# Not a title: text came first' })
    expect(ticket('---\nid: q-1\ntitle: From the field\n---\nNo heading.')).toMatchObject({ title: 'From the field', body: 'No heading.' })
    // Never closed: it's all body, and the file names it.
    expect(ticket('---\nid: q-2\n# Title', 'q-2.md')).toMatchObject({ id: 'q-2', title: 'q-2' })
    // Only the frontmatter counts: a `status:` in the body is the body's.
    expect(ticket('---\nid: q-3\nstatus: closed\n---\n# T\nstatus: open\n---\n')).toMatchObject({ status: 'closed', body: 'status: open\n---' })
    expect(ticket('---\nid: q-4\nstatus: tombstone\n---\n# [Deleted]')).toMatchObject({ status: 'tombstone', title: '[Deleted]' })
  })
})

describe('searching and sorting', () => {
  const at = (mtime: number, spec: Spec): Ticket => parseTicket(fileOf(spec), `${spec.id}.md`, mtime)
  const all = [
    at(1, { id: 'a-1', title: 'Old urgent', priority: 0 }),
    at(5, { id: 'a-2', title: 'New normal', priority: 2, type: 'bug', tags: ['ui'] }),
    at(3, { id: 'a-3', title: 'Mid normal', priority: 2, status: 'in_progress', body: 'mentions the widget' }),
    at(9, { id: 'a-4', title: 'Closed widget', priority: 1, status: 'closed' }),
    at(7, { id: 'a-5', title: 'Closed later', priority: 3, status: 'closed' }),
    at(8, { id: 'a-6', title: '[Deleted]', status: 'tombstone' }),
  ]
  const ids = (q: string, status = 'open') => search(all, { ...parseQuery(q), status }).map((t) => t.id)

  it('sorts open by priority then recency, closed by recency', () => {
    expect(ids('')).toEqual(['a-1', 'a-2', 'a-3'])
    expect(ids('', 'closed')).toEqual(['a-4', 'a-5'])
    expect(ids('', 'all')).toEqual(['a-1', 'a-4', 'a-6', 'a-2', 'a-3', 'a-5'])
    expect(ids('', 'in_progress')).toEqual(['a-3'])
  })

  it('finds words in the id, the title and the body, best first', () => {
    expect(ids('widget', 'all')).toEqual(['a-4', 'a-3'])
    expect(ids('a-3 widget', 'all')).toEqual(['a-3'])
    expect(ids('normal')).toEqual(['a-2', 'a-3'])
    expect(ids('normal nope')).toEqual([])
    expect(ids('A-5', 'all')).toEqual(['a-5'])
  })

  it('reads filters in the query', () => {
    expect(parseQuery('type:Bug #ui p2 crash')).toEqual({ words: ['crash'], type: 'bug', tag: 'ui', priority: 2 })
    expect(ids('type:bug')).toEqual(['a-2'])
    expect(ids('#ui')).toEqual(['a-2'])
    expect(ids('p0')).toEqual(['a-1'])
    expect(search(all, parseQuery('status:closed')).map((t) => t.id)).toEqual(['a-4', 'a-5'])
  })

  it('resolves partial ids, and says when one is ambiguous', () => {
    const byId = new Map(all.map((t) => [t.id, t]))
    expect(resolve(byId, 'a-4')?.id).toBe('a-4')
    expect(resolve(byId, '6')?.id).toBe('a-6')
    expect(resolve(byId, 'zz')).toBeUndefined()
    expect(() => resolve(byId, 'a-')).toThrow(/ambiguous/)
  })

  it('marks open tickets waiting on open deps blocked', () => {
    const a = at(1, { id: 'b-1', deps: ['b-2', 'gone'] })
    const b = at(1, { id: 'b-2' })
    const byId = new Map([[a.id, a], [b.id, b]])
    expect(rowOf(a, byId).blocked).toBe(true)
    b.status = 'closed'
    expect(rowOf(a, byId).blocked).toBeUndefined()
    expect(formatRow(rowOf(a, byId))).toBe('b-1  open  P2 task  Ticket b-1')
  })
})

describe('finding the folder', () => {
  it('looks up from the folder to the repository root', async () => {
    const root = await project([])
    const deep = join(root, 'a', 'b')
    await mkdir(deep, { recursive: true })
    expect(await findTicketsDir(deep)).toBe(join(root, '.tickets'))
    // A worktree (or nested repository) has its own: its .git, a file there, stops the search.
    await writeFile(join(root, 'a', '.git'), 'gitdir: elsewhere\n')
    expect(await findTicketsDir(deep)).toBeUndefined()
    await mkdir(join(root, 'a', '.tickets'))
    expect(await findTicketsDir(deep)).toBe(join(root, 'a', '.tickets'))
  })

  it('reads again only what changed', async () => {
    const root = await project([{ id: 'c-1' }, { id: 'c-2' }])
    const index = new TicketIndex(join(root, '.tickets'))
    expect(await index.refresh()).toBe(true)
    expect([...index.byId.keys()].sort()).toEqual(['c-1', 'c-2'])
    expect(await index.refresh()).toBe(false)
    await unlink(join(root, '.tickets', 'c-1.md'))
    await writeFile(join(root, '.tickets', 'c-3.md'), fileOf({ id: 'c-3', status: 'closed' }))
    expect(await index.refresh()).toBe(true)
    expect([...index.byId.keys()].sort()).toEqual(['c-2', 'c-3'])
    expect(index.counts).toEqual({ open: 1, in_progress: 0, closed: 1, all: 2 })
  })
})

describe('the daemon', () => {
  it('lists, shows, and follows the folder as it changes', async () => {
    const root = await project([
      { id: 'd-1', title: 'Parent epic', type: 'epic', priority: 1 },
      { id: 'd-2', title: 'Child', parent: 'd-1', deps: ['d-3'], links: ['d-9'] },
      { id: 'd-3', title: 'Done already', status: 'closed' },
    ])
    daemon = await testDaemon({ profile })
    const folder = join(root, 'sub')
    await mkdir(folder)
    await daemon.thread(undefined, { cwd: folder })   // loads the profile
    const state = await daemon.call<FolderState>('tickets.state', { folder })
    expect(state).toMatchObject({ dir: join(root, '.tickets'), counts: { open: 2, closed: 1, all: 3 } })

    const open = await daemon.call<ListResult>('tickets.list', { folder, status: 'open' })
    expect(open.rows.map((r) => r.id)).toEqual(['d-1', 'd-2'])
    expect(open.total).toBe(2)
    const limited = await daemon.call<ListResult>('tickets.list', { folder, status: 'all', limit: 1 })
    expect([limited.rows.length, limited.total]).toEqual([1, 3])

    const shown = await daemon.call<ShowResult>('tickets.show', { folder, id: 'd-2' })
    expect(shown.ticket.title).toBe('Child')
    expect(shown.deps).toEqual([{ id: 'd-3', title: 'Done already', status: 'closed' }])
    expect(shown.links).toEqual([{ id: 'd-9', missing: true }])
    expect(shown.parent).toMatchObject({ id: 'd-1', title: 'Parent epic' })
    expect((await daemon.call<ShowResult>('tickets.show', { folder, id: 'd-1' })).children.map((c) => c.id)).toEqual(['d-2'])
    await expect(daemon.call('tickets.show', { folder, id: 'nope' })).rejects.toThrow(/No ticket nope/)

    // A change on disk reaches the live value, without anyone asking.
    const live = await daemon.watch<FolderState>(STATE, { scope: folder })
    const version = live.value.version
    await writeFile(join(root, '.tickets', 'd-4.md'), fileOf({ id: 'd-4', title: 'Brand new', priority: 0 }))
    await live.until((s) => s.version > version && s.counts?.open === 3, 'a new ticket')
    expect((await daemon.call<ListResult>('tickets.list', { folder })).rows[0]?.id).toBe('d-4')

    // tk's way of changing one: a new file moved over the old.
    await writeFile(join(root, '.tickets', 'd-4.tmp'), fileOf({ id: 'd-4', title: 'Brand new', priority: 0, status: 'closed' }))
    await rename(join(root, '.tickets', 'd-4.tmp'), join(root, '.tickets', 'd-4.md'))
    await live.until((s) => s.counts?.closed === 2, 'closed')
  })

  it('settles a burst of changes into one read', async () => {
    const root = await project([{ id: 'e-1' }])
    daemon = await testDaemon({ profile })
    await daemon.thread(undefined, { cwd: root })
    await daemon.call('tickets.state', { folder: root })
    const live = await daemon.watch<FolderState>(STATE, { scope: root })
    const before = live.value.version
    for (let i = 2; i <= 30; i++) await writeFile(join(root, '.tickets', `e-${i}.md`), fileOf({ id: `e-${i}` }))
    await live.until((s) => s.counts?.all === 30, 'all of them')
    expect(live.value.version - before).toBeLessThanOrEqual(3)
  })

  it('finds a .tickets made later, and lets go of one removed', async () => {
    const root = await tempFolder()
    await mkdir(join(root, '.git'))
    daemon = await testDaemon({ profile })
    await daemon.thread(undefined, { cwd: root })
    expect(await daemon.call<FolderState>('tickets.state', { folder: root })).toMatchObject({ dir: null })
    await expect(daemon.call('tickets.list', { folder: root })).rejects.toThrow(/No \.tickets/)
    await mkdir(join(root, '.tickets'))
    await writeFile(join(root, '.tickets', 'f-1.md'), fileOf({ id: 'f-1' }))
    expect(await daemon.call<FolderState>('tickets.state', { folder: root })).toMatchObject({ dir: join(root, '.tickets'), counts: { all: 1 } })
    const live = await daemon.watch<FolderState>(STATE, { scope: root })
    await rm(join(root, '.tickets'), { recursive: true })
    await live.until((s) => s.dir === null, 'gone')
  })

  it('opens the pane on a ticket, and shows another in the same pane', async () => {
    const root = await project([{ id: 'g-1' }, { id: 'g-2' }])
    daemon = await testDaemon({ profile })
    const thread = await daemon.thread(undefined, { cwd: root })
    const panes = async () => {
      const list = await daemon!.call<{ id: string; panes?: { kind: string; params?: { id?: string } }[] }[]>('thread.list', {})
      return (list.find((t) => t.id === thread.id)?.panes ?? []).filter((p) => p.kind === 'tickets')
    }
    await daemon.dispatch('tickets.open', { thread: thread.id, id: 'g-1' })
    await daemon.until(async () => (await panes())[0]?.params?.id === 'g-1', 'the pane open on g-1')
    await daemon.dispatch('tickets.open', { thread: thread.id, id: 'g-2' })
    await daemon.until(async () => (await panes())[0]?.params?.id === 'g-2', 'the same pane on g-2')
    expect(await panes()).toHaveLength(1)
  })
})

describe('the agent', () => {
  it('searches and shows tickets where there are some', async () => {
    const root = await project([
      { id: 'h-1', title: 'Crash on launch', type: 'bug', priority: 0, tags: ['native'], body: 'Stack trace here.' },
      { id: 'h-2', title: 'Polish settings', deps: ['h-1'] },
      { id: 'h-3', title: 'Old crash', status: 'closed' },
    ])
    daemon = await testDaemon({
      profile,
      model: [
        callTool('tickets_search', { query: 'crash' }),
        callTool('tickets_search', { query: 'crash', status: 'all' }),
        callTool('tickets_show', { id: 'h-2' }),
        callTool('tickets_show', { id: 'nope' }),
        say('Done.'),
      ],
    })
    const thread = await daemon.thread('What is open?', { cwd: root })
    const calls = await daemon.toolCalls(thread)
    expect(calls.map((c) => c.result?.isError)).toEqual([false, false, false, true])
    expect(calls[0]!.result?.text).toContain('1 found')
    expect(calls[0]!.result?.text).toContain('h-1  open  P0 bug  Crash on launch  [native]')
    expect(calls[1]!.result?.text).toContain('h-3  closed')
    expect(calls[2]!.result?.text).toMatch(/deps \(it waits on these\):\n {2}- h-1 \[open\] Crash on launch/)
    expect(calls[2]!.result?.text).toContain('# Polish settings')
    expect(calls[3]!.result?.text).toContain('No ticket nope')
    // And a line saying where they are, and that tk writes them.
    expect(await daemon.transcript(thread)).toContain(`tk tickets in ${join(root, '.tickets')}`)
  })

  it('has no ticket tools where there are no tickets', async () => {
    const root = await tempFolder()
    await mkdir(join(root, '.git'))
    daemon = await testDaemon({ profile, model: [callTool('tickets_search', {}), say('ok')] })
    const thread = await daemon.thread('Anything?', { cwd: root })
    const [call] = await daemon.toolCalls(thread)
    expect(call?.result?.isError).toBe(true)
    expect(call?.result?.text).toContain('Tool tickets_search is not available')
    expect(await daemon.transcript(thread)).not.toContain('tk tickets in')
  })
})
