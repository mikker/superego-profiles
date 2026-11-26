// What vault is, for both halves (spread into each), and the shapes they share.
export const about = {
  name: 'vault', version: '1.1.0', api: '^5', title: 'Vault',
  panes: {
    graph: 'the vault as a graph of notes and their [[links]], coloured by top folder. Params: { focus?: "path/of/note.md" } centres it on a note.',
    note: 'a note rendered, its [[links]] clickable, with its backlinks. Params: { path: "path/of/note.md" }.',
  },
}

/** The machine setting holding the vault's folder: one vault, used where a thread's own folder isn't one. */
export const SETTING = 'vault.path'
/** The live value of the configured vault's notes (`VaultList`), kept current as files change. */
export const LIST = 'vault.list'
/** The space showing the configured vault: its notes, and one of them. Params: { path?: "path/of/note.md" }. */
export const SPACE = 'vault.home'
/** The profile this is: the one its space's threads run, and whose threads its links and panes are for. */
export const PROFILE = 'obsidian'

/** A note as the list shows it. `at`: modified, in ms since the epoch. */
export type NoteEntry = { path: string; title: string; folder: string; at: number }

/**
 * `vault.list`: the configured vault and its notes, newest first. `root` null: none set. `problem`: it can't be read
 * (gone, not a folder). `warning`: it reads, but doesn't look like an Obsidian vault (no `.obsidian/`).
 */
export type VaultList = { root: string | null; problem?: string; warning?: string; notes: NoteEntry[] }

/** `vault.graph`: every note, and a link from one to another wherever it [[links]] or ![[embeds]] it. */
export type Graph = { nodes: { id: string; title: string; folder: string }[]; edges: { from: string; to: string }[] }

/**
 * `vault.note`: a note the vault's rules find, what links to it, and the line of the heading or block asked for.
 * `root`: the vault it's in, so a view can tell whether a thread's folder reaches it.
 */
export type NoteInfo = { path: string; title: string; content: string; backlinks: { path: string; title: string }[]; line?: number; root: string }
