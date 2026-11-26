// The Vault space: the vault set in Settings, its notes newest first with a filter, and the one picked beside them
// (the note pane's view). Its thread, docked beside, runs this profile in the vault. The list follows the vault on disk.
import { useEffect, useMemo, useState } from 'react'
import { Button, PaneMessage, TextField, useDispatch, useSpaceTitle, useValue, type SpaceProps, type Store } from 'superego/ui'
import { LIST, type NoteEntry, type VaultList } from '../shared.ts'
import { NoteView, noteName } from './note.tsx'

/** How many rows the list draws at most: past that, the filter narrows it. */
const SHOWN = 500

/** The space on screen now, and its thread: [[links]] followed in it show their note here. */
export type Shown = { machine: string; thread: string | null } | null

export function VaultSpace({ machine, params, thread, open, shown, last }: SpaceProps & { shown: Store<Shown>; last: Store<string | null> }) {
  const list = useValue<VaultList | null>(machine, LIST)
  const path = typeof params.path === 'string' ? params.path : undefined
  const heading = typeof params.heading === 'string' ? params.heading : undefined
  const block = typeof params.block === 'string' ? params.block : undefined
  const [filter, setFilter] = useState('')

  useEffect(() => {
    shown.set({ machine: machine.id, thread: thread?.id ?? null })
    return () => { if (shown.get()?.machine === machine.id) shown.set(null) }
  }, [machine.id, thread?.id])
  useEffect(() => { if (path) last.set(path) }, [path])
  useSpaceTitle(noteName(path) ?? (list?.root ? list.root.split('/').at(-1) : undefined))

  const notes = useMemo(() => matching(list?.notes ?? [], filter), [list?.notes, filter])
  const picked = list?.notes.find((n) => n.path === path)

  if (list === undefined) return <PaneMessage>Reading…</PaneMessage>
  if (list === null) return <PaneMessage>The vault is starting…</PaneMessage>
  if (!list.root || list.problem) return <Unset machine={machine.id} problem={list.problem} />

  return (
    <div className="vault-space">
      <aside className="vault-space__side">
        <TextField className="vault-space__filter" type="search" placeholder={`Filter ${list.notes.length} notes`} aria-label="Filter notes"
          value={filter} onChange={(e) => setFilter(e.target.value)} />
        {list.warning && <div className="vault-space__warning" role="status">{list.warning}</div>}
        <div className="vault-space__list" role="list">
          {notes.slice(0, SHOWN).map((note) => (
            <button key={note.path} type="button" role="listitem" title={note.path}
              className={`vault-space__row ${note.path === path ? 'is-current' : ''}`} aria-current={note.path === path ? 'page' : undefined}
              onClick={() => open({ path: note.path })}>
              <span className="vault-space__title">{note.title}</span>
              <small className="vault-space__folder">{note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''}</small>
              <small className="vault-space__at">{ago(note.at)}</small>
            </button>
          ))}
          {notes.length === 0 && <div className="vault-space__quiet">{list.notes.length ? 'No notes match.' : 'No notes yet.'}</div>}
          {notes.length > SHOWN && <div className="vault-space__quiet">{notes.length - SHOWN} more</div>}
        </div>
      </aside>
      <main className="vault-space__note">
        {path
          ? <NoteView key={path} machine={machine} thread={thread} path={path} heading={heading} block={block} refresh={picked?.at}
              onOpen={(note) => open({ path: note.path })} />
          : <PaneMessage>Pick a note.</PaneMessage>}
      </main>
    </div>
  )
}

/** No vault set, or the one set can't be read: say so, and where to set it. */
function Unset({ machine, problem }: { machine: string; problem: string | undefined }) {
  const dispatch = useDispatch()
  return (
    <div className="vault-space__unset">
      <p>{problem ?? 'No vault is set.'}</p>
      <Button variant="primary" onClick={() => void dispatch('vault.settings', { machine })}>Choose the vault in Settings</Button>
    </div>
  )
}

/** The notes whose path has every word of the filter in it, in the list's order. */
export function matching(notes: NoteEntry[], filter: string) {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? notes.filter((n) => words.every((w) => n.path.toLowerCase().includes(w))) : notes
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
