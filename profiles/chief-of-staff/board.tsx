// The triage board (Direction B): action-first, zero duplication, keyboard-driven.
//
// From the top:
// - Programme header + wave progress/filter pills (board_plan), clickable to filter by wave (or click again for All).
// - ACTION REQUIRED: open lead decisions (board_ask), children's own questions (agent-ui), stalled lanes, failed lanes.
// - IN FLIGHT: working lanes (showing live tool call + held follow-up note if any), queued starts, planned lanes.
// - READY TO LAND: finished lanes not yet archived (with diff stat, merged status, one-line summary, Archive).
// - LANDED (folded by default once there's active work, open when everything is landed): archived reports kept until dismissed.
// - ANSWERED (folded by default): answered/closed decisions kept until dismissed.
//
// Keys: j/k/↑/↓ move, ⏎ open thread beside (⌘⏎ focus), 1–9 answer decision/question (z undoes for 3s), r reply in words,
// n/N next/prev open question, space fold section or expand lane details (held note, full report, files), c drop held note,
// s stop working/stalled lane, a archive settled lane, x dismiss report/answered decision, X clear settled board, ? help.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArchiveIcon, ArrowElbowDownRightIcon, ChatTextIcon, ChatsIcon, DiffStat, defineUiExtension, factsOf, Glyph, has,
  IconButton, Markdown, PaneButton, PaneHeader, PaneMessage, PaneNote, StatusGlyph, TextField, ThreadRef, useDispatch,
  useMethod, useSelection, useThreads, useValue, XIcon,
  type MachineEntry, type PaneProps, type ThreadInfo, type ToolRow,
} from 'superego/ui'
import { CHATTER_CSS, chatterSentWith } from './chatter.tsx'
import {
  about, ANSWER, BOARD, PANE, WAITING, type Board, type Changes, type Decision, type Details, type HeldNote, type Option,
  type Report, type Waiting,
} from './shared.ts'

/** How long a picked answer waits before it's sent, for `z` to take it back. */
const UNDO_MS = 3_000

const ago = (ms: number) => ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const firstLine = (text: string) => text.split('\n').find((l) => l.trim())?.trim() ?? ''
const working = (t: ThreadInfo) => t.status.state === 'working' || t.status.state === 'blocked'
const settled = (t: ThreadInfo) => t.status.state === 'idle' || t.status.state === 'done' || t.status.state === 'error'

type SectionId = 'action' | 'flight' | 'ready' | 'landed' | 'answered'

/** One row the cursor stops at, in the order drawn. */
type Item =
  | { key: string; kind: 'section'; section: SectionId }
  | { key: string; kind: 'decision'; decision: Decision }
  | { key: string; kind: 'question'; child: ThreadInfo; waiting: Waiting }
  | { key: string; kind: 'stall' | 'failed'; child: ThreadInfo; report?: Report }
  | { key: string; kind: 'flight'; child: ThreadInfo }
  | { key: string; kind: 'ready'; child: ThreadInfo; report?: Report }
  | { key: string; kind: 'landed'; report: Report }
  | { key: string; kind: 'queued' | 'planned'; title: string; at?: number; wave?: string }

type Section = { id: SectionId; title: string; items: Item[]; collapsible: boolean; defaultFolded: boolean }

/** An answer picked and waiting to be sent: what it answers, in what words, when it goes. */
type Pending = { key: string; text: string; option?: number; until: number; send(): Promise<unknown> }

/** What a child waits on, as agent-ui publishes it, lifted to the board: one of these per live child. */
function Watch({ machine, child, onChange }: { machine: MachineEntry; child: string; onChange(child: string, waiting: Waiting | undefined): void }) {
  const waiting = useValue<Waiting[]>(machine, WAITING, { scope: child })
  const first = waiting?.[0]
  useEffect(() => { onChange(child, first) }, [child, first?.id])
  useEffect(() => () => onChange(child, undefined), [child])
  return null
}

/** Numbered options; the one picked, marked while it waits to be sent. */
function Options({ options, picked, pick }: { options: Option[]; picked?: number; pick(i: number): void }) {
  return (
    <div className="staff-board__options">
      {options.map((o, i) => (
        <button key={i} type="button" className={picked === i ? 'is-picked' : ''} onClick={(e) => { e.stopPropagation(); pick(i) }}>
          <kbd>{i + 1}</kbd><span className="staff-board__label">{o.label}</span>{o.description && <span className="staff-board__desc">{o.description}</span>}
        </button>
      ))}
    </div>
  )
}

/** What a branch changed: +/−, and how many files. */
const Changed = ({ changes }: { changes: Changes }) => {
  const count = changes.files.length + (changes.more ?? 0)
  return <span className="staff-board__stat" title={changes.files.map((f) => `${f.path} +${f.added} −${f.removed}`).join('\n')}><DiffStat added={changes.added} removed={changes.removed} /> · {count} {count === 1 ? 'file' : 'files'}</span>
}

const KEYS: [string, string][] = [
  ['j k ↓ ↑', 'Move'],
  ['⏎', 'Open the thread beside (⌘⏎ in its place)'],
  ['1–9', 'Answer the decision or question under the cursor'],
  ['z', 'Take back an answer before it’s sent'],
  ['r', 'Answer in words'],
  ['n N', 'Next and previous open question'],
  ['space', 'Fold a section, or inspect a lane (report, held note, files)'],
  ['c', 'Drop the held follow-up note on the selected lane'],
  ['s', 'Stop a working or stalled lane'],
  ['a', 'Archive a finished lane'],
  ['x', 'Dismiss an answered decision or a landed report'],
  ['X', 'Clear the board: settled reports, answered decisions, the plan'],
  ['? esc', 'These keys'],
]

function BoardPane({ machine, thread }: PaneProps) {
  const dispatch = useDispatch()
  const { select } = useSelection()
  const all = useThreads(machine.id)
  const mine = useValue<Board>(machine, BOARD, { scope: thread.id }) ?? undefined
  const children = useMemo(() => (all ?? []).filter((t) => t.parent === thread.id && !t.archived).sort((a, b) => a.createdAt - b.createdAt), [all, thread.id])
  const reports = mine?.reports ?? []
  const decisions = mine?.decisions ?? []
  const plan = mine?.plan
  const held = mine?.held ?? {}
  const activity = mine?.activity ?? {}
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t) }, [])
  const changed = [...children.map((c) => `${c.id}:${c.activeAt}:${c.status.state}`), ...reports.map((r) => `${r.id}:${r.at}`)].join(',')
  const { data } = useMethod<Details[]>(machine.id, 'staff.details', { id: thread.id },
    { enabled: machine.state === 'connected' && has(machine, 'ext:staff'), refresh: changed })
  const details = useMemo(() => Object.fromEntries((data ?? []).map((d) => [d.id, d])), [data])

  // What each child waits on, as its Watch says.
  const [waits, setWaits] = useState<Record<string, Waiting>>({})
  const onWait = useMemo(() => (child: string, waiting: Waiting | undefined) => setWaits((w) => {
    if (w[child]?.id === waiting?.id) return w
    const next = { ...w }
    if (waiting) next[child] = waiting
    else delete next[child]
    return next
  }), [])

  const [waveFilter, setWaveFilter] = useState<number | null>(null)
  const [cursor, setCursor] = useState<string>()
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [replying, setReplying] = useState<string>()
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [help, setHelp] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const root = useRef<HTMLDivElement>(null)

  // Clear wave filter if the plan goes away or shrinks.
  useEffect(() => {
    if (waveFilter !== null && (!plan || waveFilter >= plan.waves.length)) setWaveFilter(null)
  }, [waveFilter, plan?.waves.length])

  // A picked answer goes when its moment is up, or at once if the board goes away first.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const flush = (p: Pending | undefined) => {
    if (!p) return
    pendingRef.current = undefined
    setPending((q) => q === p ? undefined : q)
    p.send().then(() => setFailed(({ [p.key]: _, ...rest }) => rest), (error: Error) => setFailed((f) => ({ ...f, [p.key]: error.message })))
  }
  const [, tick] = useState(0)
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => { if (Date.now() >= pending.until) flush(pending); else tick((n) => n + 1) }, 200)
    return () => clearInterval(t)
  }, [pending])
  useEffect(() => () => flush(pendingRef.current), [])

  // ── Wave metadata & filtering ───────────────────────────────────────────────────────────────────────────────────────
  const reportOf = useMemo(() => new Map(reports.map((r) => [r.id, r])), [reports])
  const gone = useMemo(() => reports.filter((r) => !children.some((c) => c.id === r.id)), [reports, children])
  const queued = mine?.queued ?? []
  const queueKey = (q: Board['queued'][number]) => `queued:${q.id ?? q.title}`

  const waveMeta = useMemo(() => {
    if (!plan?.waves.length) return []
    return plan.waves.map((w, index) => {
      const ids = new Set(w.lanes)
      let active = 0
      let landedCount = 0
      for (const lane of w.lanes) {
        const c = children.find((x) => x.id === lane)
        if (c) {
          if (working(c)) active++
          else if (settled(c) && reportOf.get(c.id)?.outcome === 'done') landedCount++
        } else if (gone.some((r) => r.id === lane)) {
          landedCount++
        }
      }
      const done = w.lanes.length > 0 && landedCount === w.lanes.length
      return { index, title: w.title, lanes: w.lanes, ids, active, landedCount, done }
    })
  }, [plan, children, gone, reportOf])

  const activeWave = waveFilter !== null ? waveMeta[waveFilter] : undefined
  const inWave = (idOrTitle: string) => !activeWave || activeWave.ids.has(idOrTitle)
  const waveOfLane = (id: string) => waveMeta.find((w) => w.ids.has(id))

  // ── Build triage buckets (zero duplication: each child belongs to exactly one bucket) ──────────────────────────────
  const decisionItem = (decision: Decision): Item => ({ key: `decision:${decision.id}`, kind: 'decision', decision })

  const actionItems: Item[] = [
    ...decisions.filter((d) => !d.answer && (!activeWave || d.about.length === 0 || d.about.some((a) => inWave(a)))).map(decisionItem),
  ]
  const flightItems: Item[] = []
  const readyItems: Item[] = []

  for (const child of children) {
    if (!inWave(child.id)) continue
    const waiting = waits[child.id]
    if (waiting) {
      actionItems.push({ key: `question:${child.id}`, kind: 'question', child, waiting })
    } else if (mine?.stalled[child.id]) {
      actionItems.push({ key: `stall:${child.id}`, kind: 'stall', child, report: reportOf.get(child.id) })
    } else if (child.status.state === 'error') {
      actionItems.push({ key: `failed:${child.id}`, kind: 'failed', child, report: reportOf.get(child.id) })
    } else if (working(child)) {
      flightItems.push({ key: `flight:${child.id}`, kind: 'flight', child })
    } else {
      readyItems.push({ key: `ready:${child.id}`, kind: 'ready', child, report: reportOf.get(child.id) })
    }
  }

  for (const q of queued) {
    if (activeWave && (!q.id || !activeWave.ids.has(q.id))) continue
    flightItems.push({ key: queueKey(q), kind: 'queued', title: q.title, at: q.at })
  }

  // Planned lanes not yet started or queued.
  if (plan?.waves.length) {
    const knownIds = new Set([...children.map((c) => c.id), ...gone.map((r) => r.id), ...queued.map((q) => q.id).filter(Boolean) as string[]])
    const wavesToShow = activeWave ? [activeWave] : waveMeta
    for (const w of wavesToShow) {
      for (const lane of w.lanes) {
        if (knownIds.has(lane)) continue
        flightItems.push({ key: `planned:${w.index}:${lane}`, kind: 'planned', title: lane, wave: `W${w.index + 1}` })
      }
    }
  }

  const landedItems: Item[] = gone
    .filter((r) => inWave(r.id))
    .map((report): Item => ({ key: `landed:${report.id}`, kind: 'landed', report }))

  const answeredItems: Item[] = decisions
    .filter((d) => Boolean(d.answer))
    .map(decisionItem)

  const hasActiveWork = actionItems.length > 0 || flightItems.length > 0 || readyItems.length > 0

  const sections: Section[] = [
    ...(actionItems.length ? [{ id: 'action' as const, title: 'Action required', items: actionItems, collapsible: false, defaultFolded: false }] : []),
    ...(flightItems.length ? [{ id: 'flight' as const, title: 'In flight', items: flightItems, collapsible: false, defaultFolded: false }] : []),
    ...(readyItems.length ? [{ id: 'ready' as const, title: 'Ready to land', items: readyItems, collapsible: false, defaultFolded: false }] : []),
    ...(landedItems.length ? [{ id: 'landed' as const, title: 'Landed', items: landedItems, collapsible: true, defaultFolded: hasActiveWork }] : []),
    ...(answeredItems.length ? [{ id: 'answered' as const, title: 'Answered', items: answeredItems, collapsible: true, defaultFolded: true }] : []),
  ]

  const isOpen = (s: Section) => !s.collapsible || !(folded[`section:${s.id}`] ?? s.defaultFolded)
  const items: Item[] = sections.flatMap((s) => [
    ...(s.collapsible ? [{ key: `section:${s.id}`, kind: 'section', section: s.id } as Item] : []),
    ...(isOpen(s) ? s.items : []),
  ])

  const at = items.find((i) => i.key === cursor) ?? items[0]
  useEffect(() => { if (cursor !== undefined && at && at.key !== cursor) setCursor(at.key) }, [cursor, at?.key])

  // Keep the cursor in view within the board.
  useEffect(() => {
    const box = root.current?.querySelector<HTMLElement>('.staff-board__body')
    const el = box?.querySelector<HTMLElement>(`[data-key="${CSS.escape(at?.key ?? '')}"]`)
    if (!box || !el) return
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    if (top < box.scrollTop) box.scrollTop = top - 8
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight + 8
  }, [at?.key])

  // ── Doing things ────────────────────────────────────────────────────────────────────────────────────────────────────
  const on = { machine: machine.id }
  const open = (id: string, beside = true) => beside
    ? void dispatch('pane.open', { thread: thread.id, kind: 'thread', params: { thread: id } }, on)
    : select({ machine: machine.id, thread: id })

  const threadOf = (item: Item | undefined): string | undefined => {
    if (!item) return undefined
    if (item.kind === 'decision') {
      const aboutFirst = item.decision.about[0]
      return aboutFirst && (children.find((c) => c.id === aboutFirst || same(c.title, aboutFirst))?.id ?? reports.find((r) => r.id === aboutFirst || same(r.title, aboutFirst))?.id)
    }
    if ('child' in item) return item.child.id
    if (item.kind === 'landed') return item.report.id
    return undefined
  }

  const answer = (item: Item, text: string, option?: number) => {
    if (item.kind === 'decision') {
      if (item.decision.answer) return
      const send = () => dispatch('staff.decide', { id: thread.id, decision: item.decision.id, text }, on)
      if (pending && pending.key !== item.key) flush(pending)
      setPending({ key: item.key, text, option, until: Date.now() + UNDO_MS, send })
    } else if (item.kind === 'question') {
      const { child, waiting } = item
      const send = async () => {
        await dispatch(ANSWER, { id: waiting.id, text }, on)
        await dispatch('staff.relay', { id: thread.id, child: child.id, question: waiting.question ?? waiting.title ?? '', text }, on)
      }
      if (pending && pending.key !== item.key) flush(pending)
      setPending({ key: item.key, text, option, until: Date.now() + UNDO_MS, send })
    }
    setCursor(item.key)
  }

  const optionsOf = (item: Item | undefined): Option[] =>
    item?.kind === 'decision' && !item.decision.answer ? item.decision.options : item?.kind === 'question' ? item.waiting.options ?? [] : []

  const dismiss = (item: Item | undefined) => {
    if (item?.kind === 'decision' && item.decision.answer) void dispatch('staff.dismiss', { id: thread.id, decision: item.decision.id }, on)
    else if (item?.kind === 'landed') void dispatch('staff.dismiss', { id: thread.id, child: item.report.id }, on)
    else if (item?.kind === 'ready' && item.report) void dispatch('staff.dismiss', { id: thread.id, child: item.child.id }, on)
  }

  const dropNote = (childId: string) => {
    if (held[childId]) void dispatch('staff.dropNote', { id: thread.id, child: childId }, on)
  }

  const stopLane = (child: ThreadInfo) => {
    if (working(child)) void dispatch('thread.stop', { thread: child.id }, on)
  }

  const clearable = Boolean(plan) || decisions.some((d) => d.answer) || reports.some((r) => !children.some((c) => c.id === r.id && working(c)))
  const clear = () => { if (clearable) void dispatch('staff.clear', { id: thread.id }, on) }

  const archive = (item: Item | undefined) => {
    if (item && 'child' in item && settled(item.child)) void dispatch('thread.archive', { thread: item.child.id }, on)
  }

  const toggle = (item: Item | undefined) => {
    if (item?.kind === 'section') {
      const s = sections.find((x) => x.id === item.section)!
      setFolded((f) => ({ ...f, [item.key]: isOpen(s) }))
    } else if (item) {
      setOpened((o) => ({ ...o, [item.key]: !o[item.key] }))
    }
  }

  const asks = (item: Item) => (item.kind === 'decision' && !item.decision.answer) || item.kind === 'question'

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
    const k = e.key
    if (k === 'Enter' && !e.altKey && !e.ctrlKey) {
      const id = threadOf(at)
      if (at?.kind === 'section') toggle(at)
      else if (id) open(id, !e.metaKey)
    } else if (e.metaKey || e.ctrlKey || e.altKey) return
    else if (help && (k === 'Escape' || k === '?')) setHelp(false)
    else if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
      const i = items.indexOf(at!)
      const next = items[Math.max(0, Math.min(items.length - 1, i + (k === 'j' || k === 'ArrowDown' ? 1 : -1)))]
      if (next) setCursor(next.key)
    } else if (/^[1-9]$/.test(k)) {
      const option = optionsOf(at)[Number(k) - 1]
      if (option && at) answer(at, option.label, Number(k) - 1)
    } else if (k === 'z') { if (pending) setPending(undefined) }
    else if (k === 'r') { if (at && asks(at)) setReplying(at.key) }
    else if (k === 'n' || k === 'N') {
      const asking = items.filter(asks)
      const i = items.indexOf(at!)
      const next = k === 'n' ? asking.find((o) => items.indexOf(o) > i) ?? asking[0] : asking.findLast((o) => items.indexOf(o) < i) ?? asking.at(-1)
      if (next) setCursor(next.key)
    } else if (k === ' ') toggle(at)
    else if (k === 'c') { if (at && 'child' in at) dropNote(at.child.id) }
    else if (k === 's') { if (at && 'child' in at) stopLane(at.child) }
    else if (k === 'X' || (k === 'x' && e.shiftKey)) clear()
    else if (k === 'x') dismiss(at)
    else if (k === 'a') archive(at)
    else if (k === '?') setHelp(true)
    else if (k === 'Escape') {
      if (waveFilter !== null) setWaveFilter(null)
      else root.current?.blur()
    } else return
    e.preventDefault()
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const ref = (aboutRef: string) => {
    const t = children.find((c) => c.id === aboutRef || same(c.title, aboutRef)) ?? reports.find((r) => r.id === aboutRef || same(r.title, aboutRef))
    return t ? <ThreadRef key={aboutRef} machine={machine.id} id={t.id} /> : <span key={aboutRef}>{aboutRef}</span>
  }
  const row = (item: Item, className: string, inner: ReactNode) => (
    <div key={item.key} data-key={item.key} className={`staff-board__item ${className}${item === at ? ' is-cursor' : ''}`} onClick={() => { setCursor(item.key); if (item.kind === 'section') toggle(item) }}>
      {inner}
    </div>
  )
  const reply = (item: Item) => replying === item.key && (
    <TextField
      autoFocus className="staff-board__reply" placeholder="Answer in words"
      onKeyDown={(e) => {
        const value = e.currentTarget.value.trim()
        if (e.key === 'Enter' && value) { answer(item, value); setReplying(undefined); root.current?.focus() }
        if (e.key === 'Escape') { setReplying(undefined); root.current?.focus() }
        e.stopPropagation()
      }}
    />
  )
  const sending = (item: Item) => {
    if (pending?.key === item.key) {
      return <div className="staff-board__sending">Sending “{pending.text}” in {Math.max(1, Math.ceil((pending.until - Date.now()) / 1000))}… <kbd>z</kbd> takes it back</div>
    }
    return failed[item.key] ? <div className="staff-board__failed">{failed[item.key]}</div> : null
  }

  const heldBadge = (childId: string, note: HeldNote | undefined) => note && (
    <span className="staff-board__held" title={note.text}>
      {note.count === 1 ? '1 note held' : `${note.count} notes held`}
      <button type="button" className="staff-board__inlinebtn" onClick={(e) => { e.stopPropagation(); dropNote(childId) }} title="Drop held note (c)">Drop</button>
    </span>
  )

  const inspectBlock = (itemKey: string, note: HeldNote | undefined, changes: Changes | undefined) => opened[itemKey] && (note || changes?.files.length) && (
    <div className="staff-board__inspect">
      {note && (
        <div className="staff-board__heldbox">
          <div className="staff-board__heldhead">Held follow-up ({note.count === 1 ? '1 note' : `${note.count} combined`} · sends when idle)</div>
          <Markdown text={note.text} compact />
        </div>
      )}
      {changes?.files.length ? (
        <div className="staff-board__files">
          {changes.files.slice(0, 8).map((f) => (
            <div key={f.path} className="staff-board__file">
              <span>{f.path}</span>
              <DiffStat added={f.added} removed={f.removed} />
            </div>
          ))}
          {(changes.more ?? 0) + Math.max(0, changes.files.length - 8) > 0 && (
            <div className="staff-board__meta">+{(changes.more ?? 0) + Math.max(0, changes.files.length - 8)} more files</div>
          )}
        </div>
      ) : null}
    </div>
  )

  const said = (item: Item, report: Report) => report.answer && (
    <div className="staff-board__sub staff-board__said"><Markdown text={report.answer} compact {...(opened[item.key] ? {} : { lines: 1 })} /></div>
  )

  const renderItem = (item: Item): ReactNode => {
    if (item.kind === 'decision') {
      const { decision: d } = item
      if (d.answer) {
        return row(item, 'staff-board__ask is-answered', <>
          <div className="staff-board__line"><Glyph shape="landed" className="staff-board__answered" /><span className="staff-board__q">{d.question}</span>
            <IconButton label="Dismiss" onClick={(e) => { e.stopPropagation(); dismiss(item) }}><XIcon /></IconButton></div>
          <div className="staff-board__about">→ {d.answer.text}{d.answer.by === 'lead' ? ' (closed by the lead)' : ''} · {ago(now - d.answer.at)}</div>
        </>)
      }
      return row(item, 'staff-board__ask', <>
        <div className="staff-board__line"><Glyph shape="question" /><span className="staff-board__q">{d.question}</span></div>
        <div className="staff-board__about">{d.about.length ? <>the lead, about {d.about.map((a, i) => <span key={a}>{i ? ', ' : ''}{ref(a)}</span>)}</> : 'the lead'} · {ago(now - d.at)}</div>
        <Options options={d.options} picked={pending?.key === item.key ? pending.option : undefined} pick={(i) => answer(item, d.options[i]!.label, i)} />
        {sending(item)}{reply(item)}
      </>)
    }
    if (item.kind === 'question') {
      const { child, waiting: w } = item
      const note = held[child.id]
      return row(item, 'staff-board__ask', <>
        <div className="staff-board__line"><Glyph shape="question" /><span className="staff-board__q">{firstLine(w.question ?? w.title ?? 'Waiting for your answer')}</span>{heldBadge(child.id, note)}</div>
        <div className="staff-board__about"><ThreadRef machine={machine.id} id={child.id} /> asks · {ago(now - w.at)}</div>
        {w.question
          ? <><Options options={w.options ?? []} picked={pending?.key === item.key ? pending.option : undefined} pick={(i) => answer(item, w.options![i]!.label, i)} />{sending(item)}{reply(item)}</>
          : <div className="staff-board__about">Answer it in its thread: <kbd>⏎</kbd></div>}
        {inspectBlock(item.key, note, mine?.changes[child.id])}
      </>)
    }
    if (item.kind === 'stall') {
      const { child } = item
      const stall = mine!.stalled[child.id]!
      const note = held[child.id]
      const changes = mine?.changes[child.id]
      return row(item, 'staff-board__ask', <>
        <div className="staff-board__line">
          <Glyph shape="stalled" />
          <span className="staff-board__q"><ThreadRef machine={machine.id} id={child.id} /> stalled {ago(now - stall.since)}</span>
          {heldBadge(child.id, note)}
          <button type="button" className="staff-board__inlinebtn" onClick={(e) => { e.stopPropagation(); stopLane(child) }} title="Stop lane (s)">Stop</button>
        </div>
        {stall.call && <div className="staff-board__about is-stalled">in {stall.call.replace(/`/g, '')}</div>}
        {inspectBlock(item.key, note, changes)}
      </>)
    }
    if (item.kind === 'failed') {
      const { child, report } = item
      return row(item, 'staff-board__ask', <>
        <div className="staff-board__line">
          <StatusGlyph status={child.status} />
          <span className="staff-board__q"><ThreadRef machine={machine.id} id={child.id} /> failed</span>
          <span className="staff-board__ago">{ago(now - child.activeAt)}</span>
          <IconButton label="Archive" onClick={(e) => { e.stopPropagation(); archive(item) }}><ArchiveIcon /></IconButton>
        </div>
        {(child.status.msg || report?.answer) && <div className="staff-board__about">{firstLine(child.status.msg ?? report?.answer ?? '')}</div>}
      </>)
    }
    if (item.kind === 'flight') {
      const { child } = item
      const tree = factsOf<{ branch: string }>(child, 'worktrees')
      const changes = mine?.changes[child.id]
      const call = activity[child.id]
      const note = held[child.id]
      const w = waveOfLane(child.id)
      const subText = call ? call.replace(/`/g, '') : tree ? tree.branch.replace(/^superego\//, '') : undefined
      return row(item, 'staff-board__lane', <>
        <div className="staff-board__line">
          <StatusGlyph status={child.status} />
          <ThreadRef machine={machine.id} id={child.id} className="staff-board__title" />
          {w && !activeWave && <span className="staff-board__wavepill">W{w.index + 1}</span>}
          {heldBadge(child.id, note)}
          {changes?.files.length ? <Changed changes={changes} /> : null}
          <span className="staff-board__ago" title="Since its last step">{ago(now - child.activeAt)}</span>
        </div>
        {subText && <div className="staff-board__sub">{subText}</div>}
        {inspectBlock(item.key, note, changes)}
      </>)
    }
    if (item.kind === 'ready') {
      const { child, report } = item
      const d = details[child.id]
      const changes = mine?.changes[child.id] ?? report?.changes
      const merged = d?.merged ?? report?.merged
      const w = waveOfLane(child.id)
      return row(item, 'staff-board__lane', <>
        <div className="staff-board__line">
          <Glyph shape="landed" />
          <ThreadRef machine={machine.id} id={child.id} className="staff-board__title" />
          {w && !activeWave && <span className="staff-board__wavepill">W{w.index + 1}</span>}
          {changes?.files.length ? <Changed changes={changes} /> : null}
          {merged !== null && merged !== undefined && <span className="staff-board__meta">{merged ? 'merged' : 'not merged'}</span>}
          <span className="staff-board__ago">{ago(now - child.activeAt)}</span>
          <IconButton label="Archive" onClick={(e) => { e.stopPropagation(); archive(item) }}><ArchiveIcon /></IconButton>
        </div>
        {report ? said(item, report) : d?.answer ? <div className="staff-board__sub">{d.answer}</div> : null}
        {inspectBlock(item.key, undefined, changes)}
      </>)
    }
    if (item.kind === 'landed') {
      const { report } = item
      const merged = details[report.id]?.merged ?? report.merged
      return row(item, 'staff-board__lane', <>
        <div className="staff-board__line">
          <Glyph shape={report.outcome === 'done' ? 'landed' : 'error'} />
          <ThreadRef machine={machine.id} id={report.id} className="staff-board__title">{report.title}</ThreadRef>
          {report.changes?.files.length ? <Changed changes={report.changes} /> : null}
          {merged !== null && merged !== undefined && <span className="staff-board__meta">{merged ? 'merged' : 'not merged'}</span>}
          <span className="staff-board__ago">{ago(now - report.at)}</span>
          <IconButton label="Dismiss" onClick={(e) => { e.stopPropagation(); dismiss(item) }}><XIcon /></IconButton>
        </div>
        {said(item, report)}
        {inspectBlock(item.key, undefined, report.changes)}
      </>)
    }
    if (item.kind === 'queued' || item.kind === 'planned') {
      return row(item, 'staff-board__lane is-quiet', <>
        <div className="staff-board__line">
          <Glyph shape={item.kind === 'queued' ? 'queued' : 'idle'} />
          <span className="staff-board__title">{item.title}</span>
          {item.wave && !activeWave && <span className="staff-board__wavepill">{item.wave}</span>}
          <span className="staff-board__meta">{item.kind}</span>
          {item.at && <span className="staff-board__ago">{ago(now - item.at)}</span>}
        </div>
      </>)
    }
    return null
  }

  // Focus handoff from the pane's column onto the board so keys work immediately.
  const drawn = Boolean(items.length || plan)
  useEffect(() => {
    const board = root.current
    const column = board?.closest<HTMLElement>('[data-column]')
    if (!board || !column) return
    const take = () => board.focus({ preventScroll: true })
    if (document.activeElement === column) take()
    const onFocus = (e: FocusEvent) => { if (e.target === column) take() }
    column.addEventListener('focus', onFocus)
    return () => column.removeEventListener('focus', onFocus)
  }, [drawn])

  const runningCount = children.filter(working).length
  const needingCount = actionItems.length
  const watches = children.map((c) => <Watch key={c.id} machine={machine} child={c.id} onChange={onWait} />)
  if (!drawn) return <>{watches}<PaneMessage>No threads started yet.</PaneMessage></>

  return (
    <div className="staff-board" ref={root} tabIndex={0} data-focus onKeyDown={onKeyDown}>
      {watches}
      <PaneHeader>
        <PaneNote>{needingCount ? `${needingCount} need${needingCount === 1 ? 's' : ''} you · ` : ''}{runningCount} running{queued.length ? ` · ${queued.length} queued` : ''}</PaneNote>
        <PaneButton onClick={clear} disabled={!clearable} title="Settled reports, answered decisions and the plan (X)">Clear board</PaneButton>
      </PaneHeader>
      <div className="staff-board__body">
        {plan && (plan.title || plan.summary || waveMeta.length > 0) && (
          <div className="staff-board__plan">
            {plan.title && <div className="staff-board__programme">{plan.title}</div>}
            {plan.summary && <div className="staff-board__summary">{plan.summary}</div>}
            {waveMeta.length > 0 && (
              <div className="staff-board__waves">
                {waveMeta.map((w) => {
                  const selected = waveFilter === w.index
                  return (
                    <button
                      key={w.index}
                      type="button"
                      className={`staff-board__wavechip${selected ? ' is-selected' : ''}${w.done ? ' is-done' : ''}`}
                      onClick={() => setWaveFilter(selected ? null : w.index)}
                      title={`Filter to Wave ${w.index + 1}: ${w.title} (click again for all)`}
                    >
                      <Glyph shape={w.done ? 'landed' : w.active > 0 ? 'working' : 'idle'} />
                      <span>W{w.index + 1} · {w.title}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {sections.map((s) => {
          const openSection = isOpen(s)
          const headerItem = s.collapsible ? items.find((i) => i.key === `section:${s.id}`) : undefined
          return (
            <section key={s.id} className={`staff-board__section staff-board__section--${s.id}`}>
              {s.collapsible && headerItem ? (
                row(headerItem, 'staff-board__sechead', <>
                  <span className={`staff-board__chev${openSection ? ' is-open' : ''}`}>▸</span>
                  <span className="staff-board__sectitle">{s.title}</span>
                  <span className="staff-board__meta">{s.items.length}</span>
                </>)
              ) : (
                <div className="staff-board__heading">
                  <span>{s.title}</span>
                  <span className="staff-board__meta">{s.items.length}</span>
                </div>
              )}
              {openSection && s.items.map(renderItem)}
            </section>
          )
        })}
      </div>
      {help && (
        <div className="staff-board__help" onClick={() => setHelp(false)}>
          <table><tbody>{KEYS.map(([keys, what]) => <tr key={keys}><td>{keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</td><td>{what}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  )
}

export default defineUiExtension({
  ...about,
  api: '^5',
  setup(superego) {
    superego.pane(PANE, { title: 'Board', component: BoardPane, menu: true })
    superego.composer.sentWith(chatterSentWith)

    const threadArg = (args: Record<string, unknown>) => typeof args.thread === 'string' ? args.thread : undefined
    const titleArg = (args: Record<string, unknown>) => typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
    const refSubject = (call: Parameters<NonNullable<ToolRow['subject']>>[0]) => {
      const id = threadArg(call.call.arguments)
      return id ? <ThreadRef machine={call.machine.id} id={id} /> : undefined
    }

    superego.tool('lane_start', {
      icon: ArrowElbowDownRightIcon,
      verbs: ['Started lane', 'Starting lane', 'Start lane failed'],
      verb: (c) => c.result?.text.startsWith('Queued as ') ? 'Queued lane' : undefined,
      subject: (c) => titleArg(c.call.arguments) ?? 'lane',
      phrase: (n) => `started ${n} ${n === 1 ? 'lane' : 'lanes'}`,
      weight: 2,
    })
    superego.tool('lane_send', {
      icon: ChatTextIcon,
      verbs: ['Sent to lane', 'Sending to lane', 'Send to lane failed'],
      verb: (c) => c.result?.text.includes('Held your note') || c.result?.text.includes('Merged into the single held note') || c.result?.text.includes('Replaced the held note')
        ? 'Held note for'
        : undefined,
      subject: refSubject,
      phrase: (n) => `messaged ${n} ${n === 1 ? 'lane' : 'lanes'}`,
      weight: 2,
    })
    superego.tool('lane_drop_note', {
      icon: XIcon,
      verbs: ['Dropped note for', 'Dropping note for', 'Drop note failed'],
      subject: refSubject,
      phrase: (n) => `dropped ${n} ${n === 1 ? 'note' : 'notes'}`,
    })
    superego.tool('lane_read', {
      icon: ChatsIcon,
      verbs: ['Read lane', 'Reading lane', 'Read lane failed'],
      subject: refSubject,
      phrase: (n) => `read ${n} ${n === 1 ? 'lane' : 'lanes'}`,
      weight: 1,
    })
    superego.tool('lane_list', {
      icon: ChatsIcon,
      verbs: ['Listed lanes', 'Listing lanes', 'List lanes failed'],
      subject: () => null,
      phrase: () => 'checked lanes',
      weight: 1,
    })
    superego.tool('lane_archive', {
      icon: ArchiveIcon,
      verbs: ['Archived lane', 'Archiving lane', 'Archive lane failed'],
      subject: refSubject,
      phrase: (n) => `archived ${n} ${n === 1 ? 'lane' : 'lanes'}`,
      weight: 1,
    })

    const css = `
      ${CHATTER_CSS}
      .staff-board { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; outline: none; }
      .staff-board__body { flex: 1; min-height: 0; overflow: auto; padding: var(--superego-space-2) var(--superego-space-3) var(--superego-space-6); line-height: 1.45; }
      .staff-board kbd { font: 11px var(--superego-mono); min-width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0 4px; border-radius: 4px; background: var(--superego-code-chip); color: var(--superego-muted); }
      .staff-board__item { border-radius: var(--superego-radius); padding: 5px var(--superego-space-3); margin: 0 calc(-1 * var(--superego-space-3)); }
      .staff-board__item.is-cursor { background: var(--superego-hover); }
      .staff-board:focus-within .staff-board__item.is-cursor { background: var(--superego-selected); }
      .staff-board__line { display: flex; align-items: center; gap: 8px; min-height: 22px; min-width: 0; }
      .staff-board__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .staff-board__meta, .staff-board__ago, .staff-board__stat { color: var(--superego-faint); font-size: var(--superego-text-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .staff-board__ago { min-width: 3em; text-align: right; }
      .staff-board__sub { margin-left: 22px; color: var(--superego-muted); font-size: var(--superego-text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .staff-board__sub.is-stalled, .staff-board__about.is-stalled { color: var(--superego-status-blocked-text); }
      .staff-board__said { white-space: normal; }
      .staff-board__said .md { line-height: 1.5; }
      .staff-board__line > .superego-status { font-size: 13px; }
      .staff-board .superego-status.staff-board__answered { color: var(--superego-faint); }
      .staff-board__heading { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-weight: 600; font-size: var(--superego-text-sm); color: var(--superego-muted); text-transform: uppercase; letter-spacing: .04em; }
      .staff-board__sechead { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
      .staff-board__sectitle { flex: 1; font-weight: 600; font-size: var(--superego-text-sm); color: var(--superego-muted); text-transform: uppercase; letter-spacing: .04em; }
      .staff-board__chev { width: 12px; color: var(--superego-faint); font-size: var(--superego-text-sm); transition: transform .15s ease; }
      .staff-board__chev.is-open { transform: rotate(90deg); }
      .staff-board__ask { padding-top: 7px; padding-bottom: 7px; }
      .staff-board__ask.is-answered { opacity: .6; }
      .staff-board__q { flex: 1; min-width: 0; }
      .staff-board__about { margin-left: 22px; color: var(--superego-muted); font-size: var(--superego-text-sm); }
      .staff-board__options { display: flex; flex-direction: column; gap: 1px; margin: 6px 0 0 14px; }
      .staff-board__options button { all: unset; display: flex; align-items: baseline; gap: 8px; padding: 3px 8px; border-radius: var(--superego-radius); cursor: default; }
      .staff-board__options button:hover { background: var(--superego-hover); }
      .staff-board__options button.is-picked { background: color-mix(in oklab, var(--superego-accent) 14%, transparent); }
      .staff-board__options button.is-picked kbd { background: var(--superego-accent); color: var(--superego-accent-text); }
      .staff-board__desc { color: var(--superego-muted); font-size: var(--superego-text-sm); }
      .staff-board__sending { margin: 6px 0 0 22px; font-size: var(--superego-text-sm); color: var(--superego-accent); display: flex; gap: 6px; align-items: center; }
      .staff-board__failed { margin: 6px 0 0 22px; font-size: var(--superego-text-sm); color: var(--superego-status-error-text); }
      .staff-board__reply { margin: 6px 0 0 22px; width: calc(100% - 22px); }
      .staff-board__plan { padding: var(--superego-space-2) 0; }
      .staff-board__programme { font-weight: 600; font-size: calc(15px * var(--superego-text-scale)); }
      .staff-board__summary { color: var(--superego-muted); margin-top: 2px; }
      .staff-board__waves { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--superego-space-2); }
      .staff-board__wavechip { all: unset; display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: var(--superego-text-sm); color: var(--superego-muted); background: var(--superego-hover); cursor: pointer; }
      .staff-board__wavechip:hover { color: var(--superego-text); }
      .staff-board__wavechip.is-selected { background: color-mix(in oklab, var(--superego-accent) 18%, transparent); color: var(--superego-accent); }
      .staff-board__wavechip.is-done { opacity: .75; }
      .staff-board__wavepill { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--superego-code-chip); color: var(--superego-faint); white-space: nowrap; }
      .staff-board__held { display: inline-flex; align-items: center; gap: 5px; font-size: var(--superego-text-sm); color: var(--superego-accent); white-space: nowrap; }
      .staff-board__inlinebtn { all: unset; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--superego-code-chip); color: var(--superego-muted); cursor: pointer; white-space: nowrap; }
      .staff-board__inlinebtn:hover { background: var(--superego-hover); color: var(--superego-text); }
      .staff-board__inspect { margin: 6px 0 2px 22px; padding: 6px 8px; border-radius: var(--superego-radius); background: var(--superego-hover); font-size: var(--superego-text-sm); display: flex; flex-direction: column; gap: 6px; }
      .staff-board__heldhead { font-weight: 600; color: var(--superego-accent); margin-bottom: 2px; }
      .staff-board__files { display: flex; flex-direction: column; gap: 2px; }
      .staff-board__file { display: flex; justify-content: space-between; gap: 12px; color: var(--superego-muted); font-family: var(--superego-mono); font-size: 11px; }
      .staff-board__section { margin-top: var(--superego-space-4); }
      .staff-board__body > :first-child { margin-top: 0; }
      .staff-board__lane.is-quiet .staff-board__title { color: var(--superego-muted); }
      .staff-board__help { position: absolute; inset: 0; z-index: 1; background: color-mix(in oklab, var(--superego-bg) 92%, transparent); backdrop-filter: blur(6px); padding: var(--superego-space-6); }
      .staff-board__help td { padding: 4px 18px 4px 0; vertical-align: top; }
      .staff-board__help td:first-child { white-space: nowrap; display: flex; gap: 4px; }
    `
    superego.style(css)
  },
})
