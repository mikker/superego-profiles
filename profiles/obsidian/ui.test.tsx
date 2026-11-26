// vault's UI half in a window over a fake machine: the Vault space (no vault set, the notes listed, one picked and
// shown), the list's filter, and how far the global profile's links and note pane reach into other profiles' threads.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from 'superego/testing'
import type { NoteEntry, NoteInfo, VaultList } from './shared.ts'
import { matching } from './ui/space.tsx'
import ui from './ui/vault.tsx'

const NOTES: NoteEntry[] = [
  { path: 'Home.md', title: 'Home', folder: '', at: Date.now() - 60_000 },
  { path: 'Projects/Alpha.md', title: 'Alpha', folder: 'Projects', at: Date.now() - 3 * 3600_000 },
  { path: 'Daily/2026-01-01.md', title: '2026-01-01', folder: 'Daily', at: Date.now() - 9 * 86400_000 },
]

let window: TestWindow | undefined
afterEach(async () => {
  await window?.unmount()
  window = undefined
})

function machineWith(list: VaultList | null) {
  return fakeMachine({
    extensions: [{ name: 'vault', version: '1.1.0' }],
    values: { 'vault.list': list },
    methods: {
      'vault.note': ({ path }: { path: string }): NoteInfo => ({
        path: path === 'Alpha' ? 'Projects/Alpha.md' : path, title: 'Alpha', root: '/vault',
        content: '# Alpha\nThe alpha project.\n', backlinks: [{ path: 'Home.md', title: 'Home' }],
      }),
    },
  })
}

it('says when no vault is set, or the one set is gone', async () => {
  const machine = machineWith({ root: null, notes: [] })
  window = await mountUi({ machines: [machine], profile: { extensions: [ui], global: true } })
  const space = await window.render({ space: { kind: 'vault.home', params: {} } })
  await window.until(() => space.text().includes('No vault is set.'))
  expect(space.text()).toContain('Choose the vault in Settings')
  machine.setValue('vault.list', { root: '/gone', problem: "There's no folder at /gone", notes: [] })
  await window.until(() => space.text().includes("There's no folder at /gone"))
})

it('lists the notes as the daemon has them, and shows the one picked', async () => {
  const machine = machineWith({ root: '/vault', warning: '/vault has no .obsidian folder: it may not be an Obsidian vault', notes: NOTES })
  window = await mountUi({ machines: [machine], profile: { extensions: [ui], global: true } })
  const space = await window.render({ space: { kind: 'vault.home', params: {} } })
  await window.until(() => space.text().includes('Alpha'))
  const rows = [...space.container.querySelectorAll('.vault-space__title')].map((row) => row.textContent)
  expect(rows).toEqual(['Home', 'Alpha', '2026-01-01'])
  expect(space.text()).toContain('Projects')
  expect(space.text()).toContain('may not be an Obsidian vault')
  expect(space.text()).toContain('Pick a note.')

  await space.click('Alpha')
  expect(window.space()).toMatchObject({ kind: 'vault.home', params: { path: 'Projects/Alpha.md' } })
  await window.until(() => space.text().includes('The alpha project.'), 'the note shown')
  expect(space.text()).toContain('Linked from')
  // No thread docked yet: read from the vault set, not a thread's.
  expect(machine.calls.find((c) => c.method === 'vault.note')?.params).toEqual({ path: 'Projects/Alpha.md' })

  // Live: a note the daemon now lists shows up.
  machine.setValue('vault.list', { root: '/vault', notes: [{ path: 'New.md', title: 'New', folder: '', at: Date.now() }, ...NOTES] })
  await window.until(() => space.text().includes('New'))
})

it('filters by every word of the filter, in the path', () => {
  expect(matching(NOTES, '').map((n) => n.title)).toEqual(['Home', 'Alpha', '2026-01-01'])
  expect(matching(NOTES, 'proj ALPHA').map((n) => n.title)).toEqual(['Alpha'])
  expect(matching(NOTES, 'daily alpha')).toEqual([])
})

it("claims [[wikilinks]] and shows notes only in its own threads (and spaces), though it's global", async () => {
  const machine = machineWith({ root: '/vault', notes: NOTES })
  window = await mountUi({ machines: [machine], profile: { extensions: [ui], global: true } })
  const mine = testThread({ id: 't1', cwd: '/vault' })
  const other = testThread({ id: 't2', profile: { scope: 'user', name: 'default', dir: '/profiles/default' } })
  expect(window.linkHandler('wikilink:Alpha#Notes', 'link', { thread: mine })?.target?.('wikilink:Alpha#Notes', 'link')).toBe('Alpha › Notes')
  expect(window.linkHandler('wikilink:Alpha', 'link')?.scheme).toBe('wikilink')
  expect(window.linkHandler('wikilink:Alpha', 'link', { thread: other })?.target?.('wikilink:Alpha', 'link')).not.toBe('Alpha')

  // Another profile's Markdown file: the plain file editor, never the vault's note.
  const pane = await window.render({ pane: { kind: 'note', params: { path: 'README.md' } }, thread: other })
  await window.settle()
  expect(pane.text()).not.toContain('Show in graph')
  expect(machine.calls.some((c) => c.method === 'vault.note')).toBe(false)
})
