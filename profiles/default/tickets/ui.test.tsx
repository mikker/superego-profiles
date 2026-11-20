// @vitest-environment happy-dom
// tickets' UI half over a real daemon: the pane lists, filters, searches and shows tickets, follows the folder as it
// changes, and the header pill counts what's open and opens the pane.
import { cp, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'
import { PANE, STATE, type FolderState } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname

let daemon: TestDaemon | undefined
let window: TestWindow | undefined
const folders: string[] = []
afterEach(async () => {
  await window?.unmount()
  await daemon?.close()
  window = daemon = undefined
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

const file = (id: string, title: string, fields: string[] = [], body = '') =>
  ['---', `id: ${id}`, 'deps: []', 'links: []', 'created: 2026-01-01T00:00:00Z', ...fields, '---', `# ${title}`, '', body, ''].join('\n')

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'tickets-ui-'))
  folders.push(root)
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.tickets'))
  let minute = 0
  for (const [id, text] of Object.entries(files)) {
    const path = join(root, '.tickets', `${id}.md`)
    await writeFile(path, text)
    const at = new Date(Date.UTC(2026, 0, 1, 0, minute++))
    await utimes(path, at, at)
  }
  return root
}

async function open(root: string) {
  daemon = await testDaemon({ profile })
  const thread = await daemon.thread(undefined, { cwd: root })
  window = await mountUi({ machines: [daemon], profile: { ref: thread.profile!, extensions: [ui] }, select: { thread: thread.id } })
  return { daemon, window, thread }
}

const TICKETS = {
  't-1': file('t-1', 'Crash on launch', ['status: open', 'type: bug', 'priority: 0', 'tags: [native]'], 'It **crashes**.\n\n## Design\n\nGuard it.'),
  't-2': file('t-2', 'Polish settings', ['status: in_progress', 'type: task', 'priority: 2', 'deps: [t-1]', 'parent: t-4']),
  't-3': file('t-3', 'Old widget bug', ['status: closed', 'type: bug', 'priority: 1'], 'The widget was wrong.'),
  't-4': file('t-4', 'Settings epic', ['status: open', 'type: epic', 'priority: 3']),
}

describe('the pane', () => {
  it('lists open tickets by priority, filters, searches, and shows one', async () => {
    const root = await project(TICKETS)
    const { window, thread } = await open(root)
    const pane = await window.render({ pane: { kind: PANE }, thread: thread.id })
    await window.until(() => pane.text().includes('Crash on launch'), 'the list')
    const titles = () => [...pane.container.querySelectorAll('.tickets-row__title')].map((e) => e.textContent)
    expect(titles()).toEqual(['Crash on launch', 'Polish settings', 'Settings epic'])
    expect(pane.text()).not.toContain('Old widget bug')
    expect(pane.find('.tickets-row.is-in_progress .tickets-mark.is-in_progress')).not.toBeNull()
    expect(pane.find('.tickets-row .tickets-p.is-p0')?.textContent).toBe('P0')
    // Counts on the filters: open and in progress together.
    expect(pane.find('.tickets__filter[aria-pressed="true"]')?.textContent).toBe('Open3')

    await pane.click('Closed1')
    await window.until(() => titles().join() === 'Old widget bug', 'closed')
    await pane.click('All4')
    await window.until(() => titles().length === 4, 'all')

    await pane.click('Polish settings')
    await window.until(() => Boolean(pane.find('.tickets__title')?.textContent === 'Polish settings'), 'the ticket')
    expect(pane.text()).toContain('In progress')
    expect(pane.text()).toContain('Depends on')
    expect(pane.text()).toContain('Parent')
    // A dep is a link to it.
    await pane.click('Crash on launch')
    await window.until(() => pane.find('.tickets__title')?.textContent === 'Crash on launch', 'followed the dep')
    expect(pane.find('.tickets__body strong')?.textContent).toBe('crashes')
    expect(pane.text()).toContain('native')
    await pane.click('Tickets')
    await window.until(() => !pane.find('.tickets__title'), 'back to the list')
  })

  // Searching, as the agent or ⌘K opens it with a query. (The kit's `type` doesn't reach React's onChange here, so the
  // search box is driven through the pane's params; tickets.test.ts covers the search itself.)
  it('searches', async () => {
    const root = await project(TICKETS)
    const { window, thread } = await open(root)
    const titles = (pane: { container: HTMLElement }) => [...pane.container.querySelectorAll('.tickets-row__title')].map((e) => e.textContent).join()
    const widget = await window.render({ pane: { kind: PANE, params: { query: 'widget', status: 'all' } }, thread: thread.id })
    await window.until(() => titles(widget) === 'Old widget bug', 'searched')
    expect((widget.find('input[aria-label="Search tickets"]') as HTMLInputElement).value).toBe('widget')
    const bugs = await window.render({ pane: { kind: PANE, params: { query: 'type:bug', status: 'all' } }, thread: thread.id })
    await window.until(() => titles(bugs) === 'Crash on launch,Old widget bug', 'type:bug')
    const none = await window.render({ pane: { kind: PANE, params: { query: 'nothing-like-it' } }, thread: thread.id })
    await window.until(() => none.text().includes('Nothing matches “nothing-like-it”'), 'nothing')
  })

  it('opens on the ticket it was asked for', async () => {
    const root = await project(TICKETS)
    const { window, thread } = await open(root)
    const pane = await window.render({ pane: { kind: PANE, params: { id: 't-4' } }, thread: thread.id })
    await window.until(() => pane.find('.tickets__title')?.textContent === 'Settings epic', 'the epic')
    expect(pane.text()).toContain('Children')
    expect(pane.text()).toContain('Polish settings')
  })

  it('follows the folder as tickets are made and closed', async () => {
    const root = await project(TICKETS)
    const { window, thread } = await open(root)
    const pane = await window.render({ pane: { kind: PANE }, thread: thread.id })
    await window.until(() => pane.text().includes('Crash on launch'), 'the list')
    await writeFile(join(root, '.tickets', 't-5.md'), file('t-5', 'Fresh from tk', ['status: open', 'priority: 1']))
    await window.until(() => pane.text().includes('Fresh from tk'), 'the new ticket, unasked')
    await writeFile(join(root, '.tickets', 't-1.md'), TICKETS['t-1'].replace('status: open', 'status: closed'))
    await window.until(() => !pane.text().includes('Crash on launch'), 'closed, so gone from Open')
  })

  it('says how to start where there are no tickets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tickets-ui-'))
    folders.push(root)
    await mkdir(join(root, '.git'))
    const { window, thread } = await open(root)
    const pane = await window.render({ pane: { kind: PANE }, thread: thread.id })
    await window.until(() => pane.text().includes('tk create'), 'how to start')
    const header = await window.render({ view: 'tickets.pill', place: 'header', thread: thread.id })
    expect(header.text()).toBe('')
  })
})

describe('the header pill', () => {
  it('counts open tickets and opens the pane', async () => {
    const root = await project(TICKETS)
    const { daemon, window, thread } = await open(root)
    const header = await window.render({ view: 'tickets.pill', place: 'header', thread: thread.id })
    await window.until(() => header.text() === '3', 'the count')
    expect(header.find('.tickets-mark.is-in_progress')).not.toBeNull()
    await header.click('button.tickets-pill')
    await daemon.until(async () => {
      const list = await daemon.call<{ id: string; panes?: { kind: string }[] }[]>('thread.list', {})
      return Boolean(list.find((t) => t.id === thread.id)?.panes?.some((p) => p.kind === PANE))
    }, 'the pane open')

    // Nothing open: no pill.
    const live = await daemon.watch<FolderState>(STATE, { scope: root })
    for (const id of ['t-1', 't-2', 't-4'] as const) await writeFile(join(root, '.tickets', `${id}.md`), TICKETS[id].replace(/status: \w+/, 'status: closed'))
    await live.until((s) => s.counts?.open === 0 && s.counts.in_progress === 0, 'all closed')
    await window.until(() => header.text() === '', 'the pill gone')
  })
})

// The window loads a profile's UI from inside that profile's folder only: chief-of-staff lists tickets' UI through
// ./tickets, a symlink to this folder. Check every profile that lists it serves it, and what it imports.
describe('the profiles that list tickets', () => {
  it('serve its UI, and every module it imports, as the window loads them', async () => {
    const root = dirname(profile)
    const dataDir = await mkdtemp(join(tmpdir(), 'tickets-profiles-'))
    folders.push(dataDir)
    await cp(root, join(dataDir, 'profiles'), { recursive: true, verbatimSymlinks: true, filter: (src) => !/(^|\/)node_modules$/.test(src) })
    daemon = await testDaemon({ dataDir, profile: join(dataDir, 'profiles', 'default') })
    const listing: string[] = []
    for (const name of await readdir(join(dataDir, 'profiles'))) {
      const ref = { scope: 'user', name, dir: join(dataDir, 'profiles', name) }
      const text = await readFile(join(ref.dir, 'profile.ts'), 'utf8').catch(() => '')
      if (!/tickets\/(ui|daemon)\.tsx?/.test(text)) continue
      listing.push(name)
      const { entries } = await daemon.call<{ entries: string[] }>('profile.ui', ref)
      expect(entries.some((e) => /tickets\/ui\.tsx$/.test(e)), `${name} lists tickets' UI`).toBe(true)
      const queue = [...entries]
      const seen = new Set<string>()
      while (queue.length) {
        const path = queue.shift()!
        if (seen.has(path)) continue
        seen.add(path)
        const module = await daemon.call<{ path: string; code: string }>('profile.module', { ...ref, path })
          .catch((error: Error) => { throw new Error(`${name}: ${path}: ${error.message}`) })
        for (const [, spec] of module.code.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(normalize(join(dirname(module.path), spec!)))
      }
    }
    expect(listing.sort()).toEqual(['chief-of-staff', 'default'])
  })
})
