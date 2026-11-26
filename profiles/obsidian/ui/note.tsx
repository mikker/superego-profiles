// The note pane: a note as Obsidian shows it, live preview to read and edit in one place (Superego's file editor), and
// the notes linking to it below. Show in graph centres the graph on it. The Vault space shows notes with the same view.
// [[wikilinks]] are this profile's: anywhere in its threads (a message, ⌃O, a note), [[Note#Heading|alias]] opens the
// note pane on the note the vault's rules find (a path, a title anywhere in the vault, an alias), at that heading.
import type { ReactNode } from 'react'
import { Button, FileEditor, has, PaneMessage, TextEditor, useDispatch, useMethod, type MachineEntry, type PaneProps, type ThreadInfo } from 'superego/ui'
import { PROFILE, type NoteInfo } from '../shared.ts'

type Params = { path?: string; heading?: string; block?: string }

/** Whether a thread is this profile's: the profile is global, so its panes are offered in every thread. */
export const ours = (thread: ThreadInfo | undefined) => thread?.profile?.name === PROFILE

export function NotePane({ machine, thread, pane }: PaneProps) {
  const dispatch = useDispatch()
  const { path, heading, block } = (pane.params ?? {}) as Params
  const open = (kind: string, params: Record<string, unknown>, title?: string) => void dispatch('pane.open', { thread: thread.id, kind, params, ...(title ? { title } : {}) }, { machine: machine.id })

  if (!path) return <PaneMessage>No note given.</PaneMessage>
  // Another profile's thread: a Markdown file there is a file, as the core's editor shows it.
  if (!ours(thread)) return <FileEditor machine={machine} thread={thread} path={path} />
  return (
    <NoteView machine={machine} thread={thread} path={path} heading={heading} block={block} refresh={thread.activeAt}
      onOpen={(note) => open('note', { path: note.path }, note.title)}
      actions={(note) => <Button onClick={() => open('graph', { focus: note.path })}>Show in graph</Button>} />
  )
}

/**
 * A note of the vault: in the file editor when `thread` works in the vault (it reads and saves through the thread's
 * folder), else rendered to read. With no thread, the vault set in Settings. `refresh`: read again as it changes.
 */
export function NoteView({ machine, thread, path, heading, block, refresh, onOpen, actions }: {
  machine: MachineEntry
  thread: ThreadInfo | undefined
  path: string
  heading?: string | undefined
  block?: string | undefined
  refresh?: unknown
  onOpen(note: { path: string; title: string }): void
  actions?(note: NoteInfo): ReactNode
}) {
  const { data: note, error } = useMethod<NoteInfo>(machine.id, 'vault.note',
    { ...(thread ? { thread: thread.id } : {}), path, ...(heading ? { heading } : {}), ...(block ? { block } : {}) },
    { enabled: has(machine, 'ext:vault@^1'), refresh })

  if (error) return <PaneMessage>{error.message}</PaneMessage>
  if (!note) return <PaneMessage>Reading…</PaneMessage>
  const backlinks = note.backlinks.length > 0 && (
    <div className="vault-note__backlinks">
      <h3>Linked from</h3>
      {note.backlinks.map((b) => <a key={b.path} href="#" onClick={(e) => { e.preventDefault(); onOpen(b) }}>{b.title}</a>)}
    </div>
  )
  if (thread && thread.cwd === note.root) {
    return (
      <FileEditor key={note.path} machine={machine} thread={thread} path={note.path} {...(note.line ? { line: note.line } : {})} actions={actions?.(note)}>
        {backlinks}
      </FileEditor>
    )
  }
  return (
    <div className="vault-note">
      <div className="vault-note__bar"><span className="vault-note__path">{note.path}</span>{actions?.(note)}</div>
      <TextEditor key={note.path} value={note.content} markdown mode="rendered" readOnly path={note.path} {...(note.line ? { line: note.line } : {})}
        place={`vault:${machine.id}/${note.root}/${note.path}`} links={{ machine: machine.id, ...(thread ? { thread } : {}) }}>
        {backlinks || null}
      </TextEditor>
    </div>
  )
}

/** The note pane's title: the note's name. */
export const noteTitle = (pane: { params?: unknown }) => noteName((pane.params as Params | undefined)?.path) ?? 'Note'

/** A note's name, from its path. */
export const noteName = (path: string | undefined) => path?.split('/').at(-1)?.replace(/\.md$/i, '')
