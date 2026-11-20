// tickets, UI half: the folder's tk tickets as a pane (a list to filter and search, and the ticket picked, rendered;
// side by side when the pane is wide, one at a time when it's narrow), and a quiet count of open tickets in the
// thread's header that opens it.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowLeftIcon, call, defineUiExtension, FileTextIcon, has, ListIcon, List, ListItem, Markdown, MagnifyingGlassIcon, PaneMessage,
  TextField, useDispatch, useMethod, useValue,
  type MachineEntry, type PaneProps, type ThreadInfo, type ViewProps,
} from 'superego/ui'
import {
  about, PANE, STATE, STATUS_FILTERS,
  type FolderState, type ListResult, type ShowResult, type StatusFilter, type TicketRef, type TicketRow,
} from './shared.ts'

const usable = (machine: MachineEntry) => machine.state === 'connected' && has(machine, 'ext:tickets')
const useFolderState = (machine: MachineEntry, thread: ThreadInfo) =>
  useValue<FolderState>(machine, STATE, { scope: thread.cwd }) ?? undefined

/**
 * Have the daemon look for the folder's `.tickets` again (it publishes what it finds): as the thread is shown, and as
 * the window comes back to the front, so tickets made meanwhile show. Changes to the files themselves come by its watch.
 */
function useLook(machine: MachineEntry, thread: ThreadInfo) {
  const ok = usable(machine)
  useEffect(() => {
    if (!ok) return
    const look = () => void call(machine.id, 'tickets.state', { folder: thread.cwd }).catch((error: Error) => console.debug(`tickets: ${error.message}`))
    const shown = () => { if (document.visibilityState === 'visible') look() }
    look()
    window.addEventListener('focus', look)
    document.addEventListener('visibilitychange', shown)
    return () => { window.removeEventListener('focus', look); document.removeEventListener('visibilitychange', shown) }
  }, [ok, machine.id, thread.cwd])
}

const openCount = (s: FolderState | undefined) => (s?.counts ? s.counts.open + s.counts.in_progress : 0)

const STATUS_WORD: Record<string, string> = { open: 'Open', in_progress: 'In progress', closed: 'Closed' }
const statusWord = (status: string) => STATUS_WORD[status] ?? status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const FILTER_LABEL: Record<StatusFilter, string> = { open: 'Open', closed: 'Closed', all: 'All' }

function ago(ms: number) {
  if (!ms) return ''
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)}mo`
  return `${Math.round(s / 86400 / 365)}y`
}

const day = (iso: string | undefined) => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isNaN(at) ? iso ?? '' : new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** A ticket's status as a small mark: a ring when open, half filled in progress, a dot closed, dashed for the rest. */
function Mark({ status }: { status?: string }) {
  const kind = status === 'open' || status === 'in_progress' || status === 'closed' ? status : 'other'
  return <span className={`tickets-mark is-${kind}`} role="img" aria-label={status ? statusWord(status) : 'not found'} title={status ? statusWord(status) : undefined} />
}

const Priority = ({ p }: { p: number }) => <span className={`tickets-p is-p${p}`} title={`Priority ${p}${p === 0 ? ' (highest)' : ''}`}>P{p}</span>

// ── The header pill ──────────────────────────────────────────────────────────────────────────────────────────────────

function Pill({ machine, thread }: ViewProps<'thread'>) {
  const state = useFolderState(machine, thread)
  useLook(machine, thread)
  const dispatch = useDispatch()
  const count = openCount(state)
  if (!usable(machine) || !state?.dir || !count) return null
  const progress = state.counts?.in_progress ?? 0
  return (
    <button type="button" className="tickets-pill" title={`${count} open ticket${count === 1 ? '' : 's'}${progress ? `, ${progress} in progress` : ''}\nClick to show them`}
      onClick={() => void dispatch('tickets.open', { thread: thread.id }, { machine: machine.id }).catch((error: Error) => console.error(`tickets: ${error.message}`))}>
      <Mark status={progress ? 'in_progress' : 'open'} />{count}
    </button>
  )
}

function MenuItem({ machine, thread }: ViewProps<'thread'>) {
  const count = openCount(useFolderState(machine, thread))
  return <>Tickets: {count} open</>
}

// ── The pane ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const PAGE = 200

type Params = { id?: string; query?: string; status?: StatusFilter }
function paramsOf(raw: unknown): Params {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ...(typeof p.id === 'string' && p.id ? { id: p.id } : {}),
    ...(typeof p.query === 'string' ? { query: p.query } : {}),
    ...(STATUS_FILTERS.includes(p.status as StatusFilter) ? { status: p.status as StatusFilter } : {}),
  }
}

function TicketsPane({ machine, thread, pane }: PaneProps) {
  const ok = usable(machine)
  const folder = thread.cwd
  const state = useFolderState(machine, thread)
  useLook(machine, thread)

  // What it was opened with: a ticket to show, a search, a status. Opened again with others (the agent, ⌘K): those.
  const params = paramsOf(pane.params)
  const [selected, setSelected] = useState<string | undefined>(params.id)
  useEffect(() => { if (params.id) setSelected(params.id) }, [params.id])
  const [status, setStatus] = useState<StatusFilter>(params.status ?? 'open')
  useEffect(() => { if (params.status) setStatus(params.status) }, [params.status])
  const [text, setText] = useState(params.query ?? '')
  const [query, setQuery] = useState(text.trim())
  useEffect(() => { if (params.query !== undefined) setText(params.query) }, [params.query])
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 120); return () => clearTimeout(t) }, [text])
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [status, query])

  const ready = ok && Boolean(state?.dir)
  const listed = useMethod<ListResult>(machine.id, 'tickets.list', { folder, status, query, limit }, { enabled: ready, refresh: state?.version })
  const shown = useMethod<ShowResult>(machine.id, 'tickets.show', { folder, id: selected ?? '' }, { enabled: ready && Boolean(selected), refresh: state?.version })

  if (!has(machine, 'ext:tickets')) return <PaneMessage>Tickets aren't set up on {machine.label}.</PaneMessage>
  if (machine.state !== 'connected') return <PaneMessage>{machine.label} is offline.</PaneMessage>
  if (!state) return <PaneMessage>Loading…</PaneMessage>
  if (!state.dir) {
    return <PaneMessage><div className="tickets-empty"><ListIcon size={20} aria-hidden /><p>No <code>.tickets</code> folder here or above it, up to the repository root. <code>tk create</code> makes one.</p></div></PaneMessage>
  }

  const counts = listed.data?.counts ?? state.counts
  const rows = listed.data?.rows
  const pick = (id: string) => setSelected(id)

  return (
    <div className="tickets"><div className={`tickets__grid${selected ? ' has-selection' : ''}`}>
      <section className="tickets__list" aria-label="Tickets">
        <div className="tickets__bar">
          <label className="tickets__search">
            <MagnifyingGlassIcon size={13} aria-hidden />
            <TextField value={text} placeholder="Search id, title, text · type:bug #tag p1" aria-label="Search tickets"
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && text) { e.stopPropagation(); setText('') } }} />
          </label>
          <div className="tickets__filters" role="group" aria-label="Status">
            {STATUS_FILTERS.map((f) => {
              const n = f === 'open' ? (counts ? counts.open + counts.in_progress : undefined) : counts?.[f]
              return (
                <button key={f} type="button" className="tickets__filter" aria-pressed={status === f} onClick={() => setStatus(f)}>
                  {FILTER_LABEL[f]}{n !== undefined && <span className="tickets__count">{n}</span>}
                </button>
              )
            })}
          </div>
        </div>
        {listed.error ? <PaneMessage>{listed.error.message}</PaneMessage>
          : !rows ? <PaneMessage>Loading…</PaneMessage>
          : !rows.length ? <PaneMessage>{query ? `Nothing matches “${query}”.` : status === 'open' ? 'No open tickets.' : 'No tickets.'}</PaneMessage>
          : (
            <div className="tickets__scroll">
              <List className="tickets__rows">
                {rows.map((row) => <Row key={row.id} row={row} selected={row.id === selected} onPick={pick} />)}
              </List>
              {listed.data && listed.data.total > rows.length && (
                <button type="button" className="tickets__more" onClick={() => setLimit((n) => n + PAGE)}>
                  Show more ({listed.data.total - rows.length} left)
                </button>
              )}
            </div>
          )}
      </section>
      <section className="tickets__detail" aria-label="Ticket">
        {selected
          ? <Detail result={shown.data?.ticket.id === selected || shown.data?.ticket.id.includes(selected) ? shown.data : undefined}
              error={shown.error} machine={machine} thread={thread} dir={state.dir} onPick={pick} onBack={() => setSelected(undefined)} />
          : <PaneMessage>Pick a ticket.</PaneMessage>}
      </section>
    </div></div>
  )
}

function Row({ row, selected, onPick }: { row: TicketRow; selected: boolean; onPick: (id: string) => void }) {
  return (
    <ListItem selected={selected} onClick={() => onPick(row.id)} className={`tickets-row is-${row.status}`}
      leading={<Mark status={row.status} />} trailing={<Priority p={row.priority} />}>
      <span className="tickets-row__title">{row.title}</span>
      <span className="tickets-row__meta">
        <span className="tickets-id">{row.id}</span>
        <span>{row.type}</span>
        {row.blocked && <span className="tickets-blocked">blocked</span>}
        {row.status !== 'open' && row.status !== 'closed' && <span>{statusWord(row.status).toLowerCase()}</span>}
        <span title={new Date(row.mtime).toLocaleString()}>{ago(row.mtime)}</span>
      </span>
    </ListItem>
  )
}

function Detail({ result, error, machine, thread, dir, onPick, onBack }: {
  result: ShowResult | undefined; error: Error | undefined; machine: MachineEntry; thread: ThreadInfo; dir: string
  onPick: (id: string) => void; onBack: () => void
}) {
  const dispatch = useDispatch()
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }) }, [result?.ticket.id])
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onBack() } }
  const t = result?.ticket
  const back = <button type="button" className="tickets__back" onClick={onBack}><ArrowLeftIcon size={13} aria-hidden />Tickets</button>
  if (!t) return <div className="tickets__ticket">{back}<PaneMessage>{error ? error.message : 'Loading…'}</PaneMessage></div>
  const openFile = () => void dispatch('pane.open', { thread: thread.id, kind: 'editor', params: { path: `${dir}/${t.file}` } }, { machine: machine.id })
    .catch((err: Error) => console.error(`tickets: ${err.message}`))
  return (
    <div className="tickets__ticket" ref={scroller} onKeyDown={onKeyDown}>
      <div className="tickets__head">
        {back}
        <span className="tickets-id">{t.id}</span>
        <button type="button" className="tickets__file" onClick={openFile} title={`Open ${t.file} in the editor`}><FileTextIcon size={13} aria-hidden />File</button>
      </div>
      <h2 className="tickets__title">{t.title}</h2>
      <dl className="tickets__fields">
        <Field label="Status"><Mark status={t.status} />{statusWord(t.status)}</Field>
        <Field label="Type">{t.type}</Field>
        <Field label="Priority"><Priority p={t.priority} /></Field>
        {t.assignee && <Field label="Assignee">{t.assignee}</Field>}
        {t.created && <Field label="Created"><span title={t.created}>{day(t.created)}</span></Field>}
        <Field label="Changed"><span title={new Date(t.mtime).toLocaleString()}>{ago(t.mtime)} ago</span></Field>
        {t.tags.length > 0 && <Field label="Tags">{t.tags.map((tag) => <span key={tag} className="tickets-tag">{tag}</span>)}</Field>}
        {t.externalRef && <Field label="External">{t.externalRef}</Field>}
        {Object.entries(t.extra).map(([k, v]) => <Field key={k} label={k}>{v}</Field>)}
      </dl>
      {result.parent && <Refs title="Parent" refs={[result.parent]} onPick={onPick} />}
      {result.deps.length > 0 && <Refs title="Depends on" refs={result.deps} onPick={onPick} />}
      {result.links.length > 0 && <Refs title="Linked" refs={result.links} onPick={onPick} />}
      {result.children.length > 0 && <Refs title="Children" refs={result.children} onPick={onPick} />}
      <div className="tickets__body">{t.body ? <Markdown text={t.body} /> : <p className="tickets-faint">No description.</p>}</div>
    </div>
  )
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="tickets__field"><dt>{label}</dt><dd>{children}</dd></div>
)

function Refs({ title, refs, onPick }: { title: string; refs: TicketRef[]; onPick: (id: string) => void }) {
  return (
    <div className="tickets__refs">
      <h3>{title}</h3>
      <ul>
        {refs.map((r) => (
          <li key={r.id}>
            {r.missing ? (
              <span className="tickets-ref is-missing" title="Not in this folder's tickets"><Mark /><span className="tickets-id">{r.id}</span><span className="tickets-faint">not found</span></span>
            ) : (
              <button type="button" className="tickets-ref" onClick={() => onPick(r.id)}>
                <Mark status={r.status} /><span className="tickets-id">{r.id}</span><span className="tickets-ref__title">{r.title}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Styles: the window's tokens, so light and dark both work ─────────────────────────────────────────────────────────

const STYLES = `
:scope { --tickets-red: var(--superego-status-error, light-dark(#d70015, #ff6961)); --tickets-orange: light-dark(#c25e00, #ffa94d); }
.tickets-mark { flex: none; display: inline-block; width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box;
  border: 1.5px solid var(--superego-muted); vertical-align: middle; }
.tickets-mark.is-in_progress { border-color: var(--superego-accent); background: linear-gradient(90deg, var(--superego-accent) 50%, transparent 50%); }
.tickets-mark.is-closed { border-color: transparent; background: var(--superego-faint); }
.tickets-mark.is-other { border-style: dashed; border-color: var(--superego-faint); }
.tickets-p { font-family: var(--superego-mono); font-size: var(--superego-text-xs); color: var(--superego-faint); font-variant-numeric: tabular-nums; }
.tickets-p.is-p0 { color: var(--tickets-red); font-weight: 600; }
.tickets-p.is-p1 { color: var(--tickets-orange); }
.tickets-p.is-p2 { color: var(--superego-muted); }
.tickets-id { font-family: var(--superego-mono); font-size: var(--superego-text-xs); color: var(--superego-muted); }
.tickets-faint { color: var(--superego-faint); }
.tickets-blocked { color: var(--tickets-orange); }
.tickets-tag { display: inline-block; padding: 0 6px; margin: 0 4px 2px 0; border-radius: 999px; background: var(--superego-hover);
  font-size: var(--superego-text-xs); line-height: 18px; }

.tickets-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border: 0; border-radius: 999px;
  background: none; font: inherit; font-size: var(--superego-text-sm); color: var(--superego-muted); font-variant-numeric: tabular-nums; white-space: nowrap; cursor: default; }
.tickets-pill:hover { background: var(--superego-hover); color: var(--superego-text); }

.tickets { container-type: inline-size; flex: 1 1 auto; height: 100%; min-height: 0; }
.tickets__grid { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
.tickets__list, .tickets__detail { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.tickets__detail { display: none; }
.has-selection .tickets__list { display: none; }
.has-selection .tickets__detail { display: flex; }
/* Wide: the list and the ticket side by side. */
@container (min-width: 720px) {
  .tickets__grid { grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr); }
  .tickets__list, .has-selection .tickets__list { display: flex; border-right: 1px solid var(--superego-border); }
  .tickets__detail { display: flex; }
}
.tickets__bar { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-bottom: 1px solid var(--superego-border); }
.tickets__search { display: flex; align-items: center; gap: 6px; color: var(--superego-muted); }
.tickets__search > :last-child { flex: 1 1 auto; min-width: 0; }
.tickets__filters { display: flex; gap: 2px; }
.tickets__filter { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 0; border-radius: var(--superego-radius);
  background: none; font: inherit; font-size: var(--superego-text-sm); color: var(--superego-muted); cursor: default; }
.tickets__filter:hover { background: var(--superego-hover); color: var(--superego-text); }
.tickets__filter[aria-pressed="true"] { background: var(--superego-selected); color: var(--superego-text); }
.tickets__count { font-size: var(--superego-text-xs); color: var(--superego-faint); font-variant-numeric: tabular-nums; }
.tickets__scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 4px 16px; }
.tickets__rows { margin: 0; padding: 0; }
/* Two lines a row: the title, then its id, type and age. */
.superego-list-item.tickets-row { height: auto; min-height: 28px; padding: 5px 8px; align-items: flex-start; }
.tickets-row .superego-list-item__leading { display: flex; align-items: center; height: 19px; }
.tickets-row .superego-list-item__body { flex-direction: column; align-items: stretch; gap: 1px; }
.tickets-row .superego-list-item__trailing { height: 19px; }
.tickets-row__title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--superego-text); }
.tickets-row.is-closed .tickets-row__title { color: var(--superego-muted); }
.tickets-row__meta { display: flex; gap: 8px; overflow: hidden; white-space: nowrap; font-size: var(--superego-text-xs); color: var(--superego-faint); }
.tickets-row__meta .tickets-id { color: var(--superego-faint); }
.tickets__more { display: block; margin: 8px auto 0; height: 24px; padding: 0 10px; border: 0; border-radius: var(--superego-radius); background: none;
  font: inherit; font-size: var(--superego-text-sm); color: var(--superego-muted); cursor: default; }
.tickets__more:hover { background: var(--superego-hover); color: var(--superego-text); }

.tickets__ticket { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 16px 32px; display: flex; flex-direction: column; }
.tickets__head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.tickets__head .tickets-id { flex: 1 1 auto; }
.tickets__back, .tickets__file { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; margin-left: -8px; border: 0;
  border-radius: var(--superego-radius); background: none; font: inherit; font-size: var(--superego-text-sm); color: var(--superego-muted); cursor: default; }
.tickets__file { margin: 0 -8px 0 0; }
.tickets__back:hover, .tickets__file:hover { background: var(--superego-hover); color: var(--superego-text); }
.tickets__title { margin: 6px 0 10px; font-size: 1.25em; font-weight: 600; line-height: 1.3; color: var(--superego-text); user-select: text; }
.tickets__fields { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0 0 14px; font-size: var(--superego-text-sm); }
.tickets__field { display: contents; }
.tickets__field dt { color: var(--superego-faint); text-transform: capitalize; }
.tickets__field dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--superego-text); user-select: text; }
.tickets__refs { margin: 0 0 12px; }
.tickets__refs h3 { margin: 0 0 2px; font-size: var(--superego-text-xs); font-weight: 500; color: var(--superego-faint); }
.tickets__refs ul { margin: 0; padding: 0; list-style: none; }
.tickets-ref { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 26px; padding: 0 6px; margin-left: -6px; border: 0;
  border-radius: var(--superego-radius); background: none; font: inherit; font-size: var(--superego-text-sm); color: var(--superego-text); text-align: left; cursor: default; }
button.tickets-ref:hover { background: var(--superego-hover); }
.tickets-ref__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tickets__body { border-top: 1px solid var(--superego-border); padding-top: 12px; user-select: text; }
.tickets-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.tickets-empty p { margin: 0; max-width: 46ch; font-size: var(--superego-text-sm); }
/* Side by side, the list is there: no way back needed. */
@container (min-width: 720px) { .tickets__head .tickets__back { display: none; } }
`

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(PANE, { title: 'Tickets', icon: ListIcon, component: TicketsPane, menu: true })
    superego.view('tickets.pill', { title: 'Open tickets', icon: ListIcon, context: 'thread', fits: ['header'], default: 'header', component: Pill, menuItem: MenuItem })
    superego.style(STYLES)
  },
})
