// vault's tools and reads over a tiny vault, in a real daemon (superego/testing's): search_notes ranks title matches
// first and leaves .obsidian out; backlinks finds links by path, by name and by alias; vault.note finds a heading's line.
// The vault setting: checked, threads outside a vault start in it (or fall back to it), and its notes listed live.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { callTools, say, testDaemon, type TestDaemon } from 'superego/testing'
import type { ThreadInfo } from 'superego'
import type { Graph, NoteInfo, VaultList } from './shared.ts'

const profile = new URL('.', import.meta.url).pathname
const NOTES: Record<string, string> = {
  'Home.md': '# Home\nSee [[Projects/Alpha|alpha]] and [[Beta]].\n',
  'Projects/Alpha.md': '---\naliases: [A1]\n---\n# Alpha\nThe alpha project. More in [[Beta#Notes]].\n',
  'Beta.md': '# Beta\nIntro.\n## Notes\nBeta notes about alpha.\n',
  'Daily/2026-01-01.md': 'Met about [[A1]].\n',
  '.obsidian/workspace.md': 'alpha [[Beta]]\n',
}

let vault: string
let daemon: TestDaemon | undefined
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vault-'))
  for (const [path, text] of Object.entries(NOTES)) {
    await mkdir(dirname(join(vault, path)), { recursive: true })
    await writeFile(join(vault, path), text)
  }
})
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  await rm(vault, { recursive: true, force: true })
})

/** What a tool answered, as the transcript (JSON) has it. */
const answered = (transcript: string, text: string) => transcript.includes(JSON.stringify(text).slice(1, -1))

it('searches notes, title matches first, and finds backlinks by path, name and alias', async () => {
  daemon = await testDaemon({
    profile,
    model: [
      callTools(
        { name: 'search_notes', args: { query: 'alpha' } },
        { name: 'search_notes', args: { query: 'alpha project', limit: 1 } },
        { name: 'search_notes', args: { query: 'gamma' } },
        { name: 'backlinks', args: { note: 'Alpha' } },
        { name: 'backlinks', args: { note: 'Beta' } },
        { name: 'backlinks', args: { note: 'Daily/2026-01-01' } },
        { name: 'backlinks', args: { note: 'Nope' } },
      ),
      say('Found them.'),
    ],
  })
  const thread = await daemon.thread('Look around', { cwd: vault })
  const transcript = await daemon.transcript(thread.id)
  expect(answered(transcript, 'Projects/Alpha.md — # Alpha\nBeta.md — Beta notes about alpha.\nHome.md — See [[Projects/Alpha|alpha]] and [[Beta]].')).toBe(true)
  expect(answered(transcript, 'Projects/Alpha.md — # Alpha')).toBe(true)
  expect(answered(transcript, 'No notes match.')).toBe(true)
  // [[Projects/Alpha|alpha]] by path, [[A1]] by its alias.
  expect(answered(transcript, 'Daily/2026-01-01.md\nHome.md')).toBe(true)
  // [[Beta]] by name, [[Beta#Notes]] at a heading; not .obsidian's.
  expect(answered(transcript, 'Home.md\nProjects/Alpha.md')).toBe(true)
  expect(answered(transcript, 'Nothing links to Daily/2026-01-01.md.')).toBe(true)
  expect(answered(transcript, 'No note Nope.')).toBe(true)
})

it('gives the panes the graph, and a note with its backlinks and the line of a heading', async () => {
  daemon = await testDaemon({ profile })
  const thread = await daemon.thread(undefined, { cwd: vault })
  // No turn yet: its profile loads now, as a window listing the thread would have it.
  await daemon.reload()
  const graph = await daemon.call<Graph>('vault.graph', { thread: thread.id })
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(['Beta.md', 'Daily/2026-01-01.md', 'Home.md', 'Projects/Alpha.md'])
  expect(graph.edges).toHaveLength(4)
  const note = await daemon.call<NoteInfo>('vault.note', { thread: thread.id, path: 'Beta', heading: 'Notes' })
  expect(note).toMatchObject({ path: 'Beta.md', title: 'Beta', line: 3 })
  expect(note.backlinks.map((b) => b.path).sort()).toEqual(['Home.md', 'Projects/Alpha.md'])
  await expect(daemon.call('vault.note', { thread: thread.id, path: 'Nope' })).rejects.toThrow(/No note Nope/)
})

/** A folder of notes that isn't a vault (no .obsidian), for a thread to start in. */
async function elsewhere(files: Record<string, string> = { 'README.md': '# Elsewhere\nalpha, but not the vault.\n' }) {
  const dir = await mkdtemp(join(tmpdir(), 'elsewhere-'))
  for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text)
  return dir
}

it('refuses a vault setting that is not a folder, and takes one that is', async () => {
  daemon = await testDaemon({ profile })
  await expect(daemon.dispatch('settings.set', { key: 'vault.path', value: join(vault, 'nope') })).rejects.toThrow(/no folder/)
  await expect(daemon.dispatch('settings.set', { key: 'vault.path', value: 'relative/vault' })).rejects.toThrow(/full path/)
  await daemon.dispatch('settings.set', { key: 'vault.path', value: vault })
  await daemon.dispatch('settings.set', { key: 'vault.path', value: '' })
})

it('starts threads outside a vault in the one set, and leaves those in a vault where they are', async () => {
  const other = await elsewhere()
  const ownVault = await elsewhere({ 'Mine.md': '# Mine\nalpha in my own vault.\n' })
  await mkdir(join(ownVault, '.obsidian'))
  try {
    // Named as it is (not `default`, which threads with no profile asked for would run).
    daemon = await testDaemon({ profile, profileName: 'obsidian', model: [callTools({ name: 'search_notes', args: { query: 'alpha', limit: 1 } }), say('Done.')] })
    await daemon.dispatch('settings.set', { key: 'vault.path', value: vault })
    const moved = await daemon.thread('Find alpha', { cwd: other })
    expect(moved.cwd).toBe(vault)
    expect(answered(await daemon.transcript(moved.id), 'Projects/Alpha.md — # Alpha')).toBe(true)
    const kept = await daemon.thread(undefined, { cwd: ownVault })
    expect(kept.cwd).toBe(ownVault)
    // The profile is global, but its hook is its own threads': one without it stays put.
    const plain = await daemon.call<ThreadInfo>('thread.start', { cwd: other, profile: null })
    expect(plain.cwd).toBe(other)
  } finally {
    await rm(other, { recursive: true, force: true })
    await rm(ownVault, { recursive: true, force: true })
  }
})

it('falls back to the vault set for a thread whose folder is not a vault, and works as before with none set', async () => {
  const other = await elsewhere()
  try {
    daemon = await testDaemon({
      profile,
      model: [
        callTools({ name: 'search_notes', args: { query: 'alpha' } }), say('Before.'),
        callTools({ name: 'search_notes', args: { query: 'alpha', limit: 1 } }, { name: 'backlinks', args: { note: 'Beta' } }), say('After.'),
      ],
    })
    // Nothing set: the thread stays in its folder, and searches it, as it always did.
    const thread = await daemon.thread('Find alpha', { cwd: other })
    expect(thread.cwd).toBe(other)
    expect(answered(await daemon.transcript(thread.id), 'README.md — alpha, but not the vault.')).toBe(true)
    // Set now: the same thread's tools and the panes' reads use it.
    await daemon.dispatch('settings.set', { key: 'vault.path', value: vault })
    await daemon.send(thread.id, 'Again')
    const transcript = await daemon.transcript(thread.id)
    expect(answered(transcript, 'Projects/Alpha.md — # Alpha')).toBe(true)
    expect(answered(transcript, 'Home.md\nProjects/Alpha.md')).toBe(true)
    const note = await daemon.call<NoteInfo>('vault.note', { thread: thread.id, path: 'Alpha' })
    expect(note).toMatchObject({ path: 'Projects/Alpha.md', root: vault })
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

it('lists the vault set, newest first, and keeps the list current as notes change', async () => {
  daemon = await testDaemon({ profile })
  const list = await daemon.watch<VaultList>('vault.list')
  await list.until((v) => v.root === null, 'no vault yet')
  await expect(daemon.call('vault.note', { path: 'Beta' })).rejects.toThrow(/No vault is set/)

  const day = 24 * 3600
  const now = Date.now() / 1000
  for (const [i, path] of ['Home.md', 'Beta.md', 'Projects/Alpha.md', 'Daily/2026-01-01.md'].entries()) {
    await utimes(join(vault, path), now - (i + 1) * day, now - (i + 1) * day)
  }
  await daemon.dispatch('settings.set', { key: 'vault.path', value: vault })
  const first = await list.until((v) => v.notes.length === 4, 'the four notes')
  expect(first.root).toBe(vault)
  expect(first.warning).toBeUndefined()
  // Newest first; .obsidian's left out.
  expect(first.notes.map((n) => n.path)).toEqual(['Home.md', 'Beta.md', 'Projects/Alpha.md', 'Daily/2026-01-01.md'])
  expect(first.notes[2]).toMatchObject({ title: 'Alpha', folder: 'Projects' })
  // With no thread, reads are the vault set's.
  expect(await daemon.call<NoteInfo>('vault.note', { path: 'Beta' })).toMatchObject({ path: 'Beta.md', root: vault })

  // A new note, written on disk by anyone: at the top.
  await writeFile(join(vault, 'Projects/Gamma.md'), '# Gamma\n')
  const added = await list.until((v) => v.notes.some((n) => n.path === 'Projects/Gamma.md'), 'Gamma listed')
  expect(added.notes[0]!.path).toBe('Projects/Gamma.md')
  // One gone.
  await rm(join(vault, 'Beta.md'))
  await list.until((v) => !v.notes.some((n) => n.path === 'Beta.md'), 'Beta gone')
  // Obsidian's own files changing don't count.
  const before = list.seen.length
  await writeFile(join(vault, '.obsidian/workspace.json'), '{}')
  await new Promise((done) => setTimeout(done, 400))
  expect(list.seen.length).toBe(before)

  // A folder without .obsidian: listed, with a warning. Unset: empty again.
  const plain = await elsewhere()
  try {
    await daemon.dispatch('settings.set', { key: 'vault.path', value: plain })
    const warned = await list.until((v) => v.root === plain, 'the plain folder')
    expect(warned.warning).toMatch(/no \.obsidian folder/)
    expect(warned.notes.map((n) => n.path)).toEqual(['README.md'])
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
  await daemon.dispatch('settings.set', { key: 'vault.path', value: '' })
  await list.until((v) => v.root === null && v.notes.length === 0, 'unset')
  await list.stop()
})
