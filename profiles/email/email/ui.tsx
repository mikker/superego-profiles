// email, UI half: the mail pane (mailboxes, a mailbox's threads, the message, the composer), Snailblaze's triage keys,
// the inbox count in the thread's header, the card over the composer that asks before the agent sends, and how the
// email tools' calls look in the transcript.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArchiveIcon, ArrowClockwiseIcon, ArrowCounterClockwiseIcon, Button, call, CaretLeftIcon, CopyIcon, defineAction, defineUiExtension, has, Menu,
  PaneMessage, PaperclipIcon, PencilSimpleIcon, ShieldWarningIcon, Switch, TextArea, TextField, useDispatch, useMethod, useValue,
  type PaneProps, type SlotProps, type ToolRowCall, type ViewProps,
} from 'superego/ui'
import { renderMarkdown } from './markdown.ts'
import { darkens, fitToWidth, hasRemoteContent, keepDarkMail, luminance, messageDocument, readerMode as toReader, type Palette } from './render.ts'
import {
  about, displayAddr, findMailbox, mailboxName, matchSender, NO_STATE, PANE, parseAddrs, PENDING, roleMailbox, senderDomain,
  senderEmail, STATE, type Addr, type Attachment, type Detail, type DraftInput, type EmailState, type ListResult, type LoadedDraft,
  type Mailbox, type MoveMode, type PendingSend, type Summary, type Thread,
} from './shared.ts'

type Machine = PaneProps['machine']

// Glyphs the kit has no icon for, drawn in Phosphor's manner (256 box, 16 stroke).
const glyph = (d: ReactNode) => ({ size = 16 }: { size?: number; 'aria-hidden'?: boolean; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
)
export const EnvelopeIcon = glyph(<><rect x="32" y="56" width="192" height="144" rx="8" /><path d="M32 64l96 72 96-72" /></>)
const TrashIcon = glyph(<><path d="M216 56H40M104 104v64M152 104v64M200 56v144a8 8 0 0 1-8 8H64a8 8 0 0 1-8-8V56M168 56V40a16 16 0 0 0-16-16h-48a16 16 0 0 0-16 16v16" /></>)
const ReplyIcon = glyph(<><path d="M80 152l-48-48 48-48" /><path d="M224 200a96 96 0 0 0-96-96H32" /></>)
const ReplyAllIcon = glyph(<><path d="M64 152L16 104l48-48" /><path d="M112 152l-48-48 48-48" /><path d="M232 200a96 96 0 0 0-96-96H64" /></>)
const ForwardIcon = glyph(<><path d="M176 152l48-48-48-48" /><path d="M32 200a96 96 0 0 1 96-96h96" /></>)
const FlagIcon = glyph(<><path d="M48 224V48s32-24 80 0 80 0 80 0v112s-32 24-80 0-80 0-80 0" /></>)
const BookIcon = glyph(<><path d="M128 88a32 32 0 0 1 32-32h64v144h-64a32 32 0 0 0-32 32M24 200h64a32 32 0 0 1 32 32V88a32 32 0 0 0-32-32H24z" /></>)
const ReceiptIcon = glyph(<><path d="M72 104h112M72 136h112M32 208V56a8 8 0 0 1 8-8h176a8 8 0 0 1 8 8v152l-32-16-32 16-32-16-32 16-32-16z" /></>)
const NewsIcon = glyph(<><path d="M88 112h96M88 144h96M216 200H48a16 16 0 0 1-16-16V72M64 200a16 16 0 0 0 16-16V56h144v128a16 16 0 0 1-16 16" /></>)

// The window's look, read from its theme variables, so prose mail sits on the pane.

function useTheme(root: HTMLElement | null): { dark: boolean; palette?: Palette; systemDark: boolean } {
  const [theme, setTheme] = useState<{ dark: boolean; palette?: Palette; systemDark: boolean }>({ dark: false, systemDark: false })
  useEffect(() => {
    if (!root) return
    const read = () => {
      const style = getComputedStyle(root)
      const color = (v: string, fallback: string) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${v}, ${fallback})`
        root.appendChild(probe)
        const out = getComputedStyle(probe).color
        probe.remove()
        return out
      }
      const bg = color('--superego-bg', style.backgroundColor || '#fff')
      const fg = color('--superego-text', style.color || '#111')
      const dark = (luminance(bg) ?? 255) < 128
      const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
      setTheme({
        dark, systemDark,
        palette: { bg, fg, muted: color('--superego-muted', '#888'), link: color('--superego-accent', dark ? '#6cb0ff' : '#0a66d9'), border: color('--superego-border', '#ccc'), code: color('--superego-raised', dark ? '#2a2a2d' : '#f3f3f5') },
      })
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', read)
    return () => { observer.disconnect(); media?.removeEventListener('change', read) }
  }, [root])
  return theme
}

// Small things.

const PALETTE = ['#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#22c55e', '#14b8a6']
const hash = (s: string) => [...s.toLowerCase()].reduce((h, c) => ((h << 5) + h + c.charCodeAt(0)) >>> 0, 5381)
function initials(a: Addr) {
  const source = a.name.trim() || a.email.split('@')[0] || ''
  return source.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
}
function Avatar({ addr, size = 32 }: { addr: Addr | undefined; size?: number }) {
  const a = addr ?? { name: '', email: '' }
  return <span className="em-avatar" aria-hidden style={{ width: size, height: size, fontSize: size * 0.4, background: PALETTE[hash(a.email) % PALETTE.length] }}>{initials(a)}</span>
}
const LABEL_COLORS = ['#3b82f6', '#a855f7', '#ec4899', '#f97316', '#22c55e', '#14b8a6', '#6366f1', '#a16207']
const Label = ({ mailbox }: { mailbox: Mailbox }) => {
  const color = LABEL_COLORS[hash(mailbox.name) % LABEL_COLORS.length]
  return <span className="em-label" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{mailboxName(mailbox)}</span>
}
const count = (n: number) => n > 999 ? '999+' : String(Math.max(0, n))
function shortDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = (day(now) - day(d)) / 86400000
  if (diff === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' })
}
const longDate = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
const senderLabel = (from: Addr[]) => { const a = from.find((x) => x.email || x.name); return a ? a.name.trim() || a.email : '(no sender)' }
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

async function download(machine: string, a: Attachment) {
  const { data } = await call<{ data: string }>(machine, 'email.blob', { blobId: a.blobId, name: a.name, type: a.type })
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: a.type }))
  const link = document.createElement('a')
  link.href = url
  link.download = a.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// The message, in a sandboxed frame: no scripts of its own, links open outside it.

type FrameHandle = { scroll(fraction: number): void; print(): void }

function MessageFrame({ detail, remote, lightPaper, reader, dark, systemDark, palette, onKey, handle }: {
  detail: Detail; remote: boolean; lightPaper: boolean; reader: boolean; dark: boolean; systemDark: boolean; palette?: Palette
  onKey(event: KeyboardEvent): void; handle: { current: FrameHandle | null }
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const doc = useMemo(() => messageDocument({ html: detail.html, text: detail.text, remote, lightPaper, dark, systemDark, palette }),
    [detail.html, detail.text, remote, lightPaper, dark, systemDark, palette?.bg, palette?.fg, palette?.link])
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    handle.current = {
      scroll(fraction) {
        const win = frame.current?.contentWindow
        if (win) win.scrollBy({ top: win.innerHeight * fraction, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      },
      print() { frame.current?.contentWindow?.print() },
    }
    return () => { handle.current = null }
  }, [handle])
  const onLoad = () => {
    const d = frame.current?.contentDocument
    if (!d) return
    if (reader) toReader(d)
    keepDarkMail(d)
    fitToWidth(d)
    d.defaultView?.addEventListener('resize', () => fitToWidth(d))
    d.addEventListener('keydown', (event) => keyRef.current(event))
  }
  return (
    <iframe
      ref={frame}
      key={reader ? 'reader' : 'original'}
      className="em-frame"
      title={detail.summary.subject}
      // Same origin so the pane can lay it out and hear its keys; without allow-scripts nothing in the mail runs.
      // Links open in a new window, outside the sandbox; nothing else leaves it (no forms, no top navigation).
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      onLoad={onLoad}
      style={{ colorScheme: dark ? 'dark' : 'light' }}
    />
  )
}

// The composer.

type Compose = { key: number; initial: DraftInput; thread?: { ids: string[]; mailbox: string }; title: string }

function Composer({ machine, compose, onClose, onStatus, dark }: {
  machine: Machine; compose: Compose; onClose(): void; onStatus(text: string, error?: boolean): void; dark: boolean
}) {
  const dispatch = useDispatch()
  const [draft, setDraft] = useState<DraftInput>(compose.initial)
  const [showBcc, setShowBcc] = useState(Boolean(compose.initial.bcc))
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>(compose.initial.replaces ? 'saved' : 'idle')
  const [sending, setSending] = useState(false)
  const saved = useRef<string>(JSON.stringify(compose.initial))
  const latest = useRef(draft)
  latest.current = draft
  const writing = useRef<Promise<unknown>>(Promise.resolve())
  const body = useRef<HTMLTextAreaElement>(null)
  const go = (id: string, params: Record<string, unknown>) => dispatch(id, params, { machine: machine.id })

  const save = useCallback(async () => {
    const d = latest.current
    const snapshot = JSON.stringify({ ...d, replaces: null })
    if (snapshot === saved.current) return d.replaces
    setSaving('saving')
    const run = writing.current.then(async () => {
      const { id } = await go('email.saveDraft', { draft: latest.current }) as { id: string }
      saved.current = snapshot
      setDraft((cur) => ({ ...cur, replaces: id }))
      latest.current = { ...latest.current, replaces: id }
      setSaving('saved')
      return id
    }).catch((error: Error) => { setSaving('failed'); onStatus(`Couldn't save the draft: ${error.message}`, true) })
    writing.current = run
    return run
  }, [])
  useEffect(() => { saved.current = JSON.stringify({ ...compose.initial, replaces: null }) }, [])
  useEffect(() => {
    const timer = setTimeout(() => { void save() }, 1500)
    return () => clearTimeout(timer)
  }, [draft.to, draft.cc, draft.bcc, draft.subject, draft.body, draft.markdown, draft.attachments, save])
  useEffect(() => { body.current?.focus(); body.current?.setSelectionRange(0, 0) }, [])

  const { invalid } = parseAddrs([draft.to, draft.cc, draft.bcc].join(', '))
  const sendable = parseAddrs(draft.to).addrs.length > 0 && !invalid.length && draft.body.trim().length > 0 && !sending
  const send = async (archive: boolean) => {
    if (!sendable) return
    setSending(true)
    await writing.current
    try {
      const result = await go('email.send', { draft: latest.current, ...(archive && compose.thread ? { archive: compose.thread } : {}) }) as { status: string }
      onStatus(result.status)
      onClose()
    } catch (error) {
      onStatus(`Not sent: ${(error as Error).message}`, true)
      setSending(false)
    }
  }
  const close = async () => { await save(); onClose() }
  const discard = async () => {
    await writing.current
    const id = latest.current.replaces
    if (id) await go('email.deleteDraft', { id }).catch(() => {})
    onStatus('draft discarded')
    onClose()
  }
  const attach = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      try {
        const a = await go('email.upload', { name: file.name, type: file.type || 'application/octet-stream', data: await toBase64(file) }) as Attachment
        setDraft((d) => ({ ...d, attachments: [...d.attachments, a] }))
      } catch (error) { onStatus(`Couldn't attach ${file.name}: ${(error as Error).message}`, true) }
    }
  }
  const set = (patch: Partial<DraftInput>) => setDraft((d) => ({ ...d, ...patch }))
  const isReply = Boolean(compose.thread)
  return (
    <div className="em-compose" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void attach(event.dataTransfer.files) }} onKeyDown={(event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(isReply) }
      else if (event.key === 'Escape') { event.preventDefault(); void close() }
    }}>
      <div className="em-compose-head">
        <strong>{compose.title}</strong>
        <span className="em-muted">{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved to Drafts' : saving === 'failed' ? 'Couldn’t save' : ''}</span>
      </div>
      <label className="em-field"><span>To</span><TextField value={draft.to} onChange={(e) => set({ to: e.target.value })} placeholder="name@example.com" /></label>
      <label className="em-field"><span>Cc</span><TextField value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
        {!showBcc && <button type="button" className="em-link" onClick={() => setShowBcc(true)}>Bcc</button>}</label>
      {showBcc && <label className="em-field"><span>Bcc</span><TextField value={draft.bcc} onChange={(e) => set({ bcc: e.target.value })} /></label>}
      <label className="em-field"><span>Subject</span><TextField value={draft.subject} onChange={(e) => set({ subject: e.target.value })} /></label>
      {invalid.length > 0 && <div className="em-error">Not an address: {invalid.join(', ')}</div>}
      {preview && draft.markdown
        ? <iframe className="em-frame em-preview" title="Preview" sandbox="allow-same-origin" srcDoc={messageDocument({ html: renderMarkdown(draft.body), text: '', dark })} />
        : <textarea ref={body} className="em-body" value={draft.body} onChange={(e) => set({ body: e.target.value })} aria-label="Message" />}
      {draft.attachments.length > 0 && (
        <div className="em-attachments">
          {draft.attachments.map((a) => (
            <span key={a.blobId} className="em-chip"><PaperclipIcon size={12} /> {a.name} <span className="em-muted">{size(a.size)}</span>
              <button type="button" className="em-link" aria-label={`Remove ${a.name}`} onClick={() => set({ attachments: draft.attachments.filter((x) => x.blobId !== a.blobId) })}>×</button></span>
          ))}
        </div>
      )}
      <div className="em-compose-bar">
        <label className="em-button-like"><PaperclipIcon size={14} /> Attach<input type="file" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = '' }} /></label>
        <Switch label="Markdown" checked={draft.markdown} onChange={(on) => { set({ markdown: on }); if (!on) setPreview(false) }} />
        {draft.markdown && <Button onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</Button>}
        <span className="em-spacer" />
        <Button onClick={() => void discard()}>Discard</Button>
        <Button onClick={() => void close()}>Close</Button>
        {isReply && <Button disabled={!sendable} onClick={() => void send(false)}>Send</Button>}
        <Button variant="primary" disabled={!sendable} onClick={() => void send(isReply)}>{sending ? 'Sending…' : isReply ? 'Send & Archive' : 'Send'}</Button>
      </div>
    </div>
  )
}

// The pane.

type Params = { mailbox?: string; message?: string; draft?: string; search?: string }

function EmailPane({ machine, pane }: PaneProps) {
  const params = (pane.params ?? {}) as Params
  const state = useValue<EmailState>(machine, STATE) ?? NO_STATE
  const dispatch = useDispatch()
  const ready = has(machine, 'ext:email') && machine.state === 'connected' && state.state === 'ready'
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useTheme(root)
  const [width, setWidth] = useState(1200)
  useEffect(() => {
    if (!root) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(root)
    return () => observer.disconnect()
  }, [root])
  const narrow = width < 760
  const wide = width >= 1100

  const [mailboxRef, setMailboxRef] = useState(params.mailbox ?? 'inbox')
  const [search, setSearch] = useState(params.search ?? '')
  const [query, setQuery] = useState(params.search ?? '')
  const [showIgnored, setShowIgnored] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [selected, setSelected] = useState<string | undefined>()
  const [viewing, setViewing] = useState<string | undefined>(params.message)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [compose, setCompose] = useState<Compose | undefined>()
  const [reader, setReader] = useState(false)
  const [lightPaper, setLightPaper] = useState(false)
  const [remoteOnce, setRemoteOnce] = useState<string | undefined>()
  const [status, setStatus] = useState<{ text: string; error?: boolean } | undefined>()
  const [showThread, setShowThread] = useState(false)
  const [narrowView, setNarrowView] = useState<'list' | 'message'>(params.message ? 'message' : 'list')
  const frame = useRef<FrameHandle | null>(null)
  const lastIndexRef = useRef<number>(-1)
  const go = (id: string, p: Record<string, unknown>) => dispatch(id, p, { machine: machine.id })
  const say = (text: string, error = false) => setStatus({ text, error })
  useEffect(() => { if (status && !status.error) { const t = setTimeout(() => setStatus(undefined), 4000); return () => clearTimeout(t) } }, [status])

  // Params change when the agent opens the pane again on something.
  useEffect(() => { if (params.mailbox) setMailboxRef(params.mailbox) }, [params.mailbox])
  useEffect(() => { if (params.message) { setViewing(params.message); setSelected(undefined); setNarrowView('message') } }, [params.message])
  useEffect(() => { if (params.search !== undefined) { setSearch(params.search); setQuery(params.search) } }, [params.search])

  const box = findMailbox(state.mailboxes, mailboxRef) ?? roleMailbox(state.mailboxes, 'inbox')
  const isDrafts = box?.role === 'drafts'
  const list = useMethod<ListResult>(machine.id, 'email.list', { mailbox: query && mailboxRef === '*' ? undefined : box?.id, search: query || undefined, showIgnored },
    { enabled: ready && Boolean(box || query), refresh: state.version })
  useEffect(() => { setHidden(new Set()) }, [list.data])
  const threads = useMemo(() => (list.data?.threads ?? []).filter((t) => !hidden.has(t.key)), [list.data, hidden])
  useEffect(() => { if (list.data?.note) say(list.data.note) }, [list.data?.note])

  // Reset fallback index when switching mailbox or search.
  useEffect(() => { lastIndexRef.current = -1 }, [box?.id, query])

  // Triage starts at the oldest thread, as Snailblaze does; the list shows the newest first.
  const current = threads.find((t) => t.key === selected)
  const index = current ? threads.indexOf(current) : -1
  if (index >= 0) lastIndexRef.current = index
  useEffect(() => {
    if (!list.data || params.message && viewing === params.message && !selected) return
    if (!current && threads.length) {
      const i = lastIndexRef.current
      const pick = i >= 0 ? threads[Math.min(i, threads.length - 1)]! : threads[threads.length - 1]!
      setSelected(pick.key)
      setViewing(pick.latest.id)
    } else if (!threads.length) { setSelected(undefined); if (!params.message) setViewing(undefined) }
  }, [threads, current, list.data])

  const detailState = useMethod<Detail>(machine.id, 'email.message', { id: viewing }, { enabled: ready && Boolean(viewing) })
  const detail = detailState.data?.summary.id === viewing ? detailState.data : undefined
  useEffect(() => { setRemoteOnce(undefined); setLightPaper(false); setShowThread(false) }, [viewing])

  // Mark what's shown read.
  const seenRef = useRef(new Set<string>())
  useEffect(() => {
    if (!detail || detail.summary.seen || detail.summary.draft || seenRef.current.has(detail.summary.id)) return
    seenRef.current.add(detail.summary.id)
    void go('email.mark', { ids: [detail.summary.id], seen: true }).catch(() => {})
  }, [detail?.summary.id])

  const focusPane = () => {
    if (!root || compose) return
    const active = document.activeElement
    if (active && root.contains(active) && active.tagName !== 'IFRAME') return
    root.focus({ preventScroll: true })
  }

  const select = (thread: Thread | undefined) => {
    if (!thread) return
    setSelected(thread.key)
    setViewing(thread.latest.id)
    setNarrowView('message')
    document.querySelector(`[data-thread="${CSS.escape(thread.key)}"]`)?.scrollIntoView({ block: 'nearest' })
    focusPane()
  }
  const next = () => { if (index > 0) select(threads[index - 1]); else say('End of mailbox') }
  const back = () => { if (index >= 0 && index < threads.length - 1) select(threads[index + 1]); else say('At start') }

  /** Take the current thread out of the list at once, and move on to the next in the list. */
  const advance = (thread: Thread) => {
    const i = threads.indexOf(thread)
    const rest = threads.filter((t) => t !== thread)
    setHidden((h) => new Set([...h, thread.key]))
    const pick = rest[Math.min(i, rest.length - 1)]
    if (pick) { setSelected(pick.key); setViewing(pick.latest.id); focusPane() } else { setSelected(undefined); setViewing(undefined); setNarrowView('list') }
  }
  const onThread = async (mode: MoveMode | 'newsletter' | 'block' | 'block-domain' | 'receipt', destination?: string) => {
    const thread = current
    const message = thread?.latest ?? detail?.summary
    if (!message) return
    const ids = thread ? [thread.latest.id] : [message.id]
    const from = box?.id
    if (thread) advance(thread)
    try {
      let result: { status: string } | null
      if (mode === 'newsletter') result = await go('email.newsletter', { id: message.id, mailbox: from }) as { status: string }
      else if (mode === 'block' || mode === 'block-domain') result = await go('email.block', { id: message.id, domain: mode === 'block-domain', mailbox: from }) as { status: string }
      else if (mode === 'receipt') {
        // Snailblaze saves a receipt's attachments, or prints it when it has none; then archives it. Here they download
        // to this computer.
        const d = detail?.summary.id === message.id ? detail : await call<Detail>(machine.id, 'email.message', { id: message.id })
        if (d.attachments.length) for (const a of d.attachments) await download(machine.id, a)
        else frame.current?.print()
        const archived = await go('email.act', { ids, mode: 'archive', mailbox: from }) as { status: string }
        result = { status: `${d.attachments.length ? `downloaded ${d.attachments.length} attachment(s)` : 'print dialog opened'} + ${archived.status}` }
      } else result = await go('email.act', { ids, mode, mailbox: from, destination }) as { status: string }
      say(result?.status ?? 'done')
    } catch (error) {
      say((error as Error).message, true)
      setHidden((h) => { const n = new Set(h); if (thread) n.delete(thread.key); return n })
    }
  }
  const undo = async () => {
    try { say((await go('email.undo', {}) as { status: string }).status) } catch (error) { say((error as Error).message, true) }
  }
  const reply = async (all = false, forward = false) => {
    const message = detail?.summary
    if (!message) return
    try {
      const initial = await call<DraftInput>(machine.id, 'email.reply', { id: message.id, all, forward })
      const archive = !forward && current && box && current.messages.some((m) => m.id === message.id) ? { ids: [current.latest.id], mailbox: box.id } : undefined
      setCompose({ key: Date.now(), initial, thread: archive, title: forward ? 'Forward' : all ? 'Reply all' : 'Reply' })
    } catch (error) { say((error as Error).message, true) }
  }
  const newMessage = (to = '') => setCompose({ key: Date.now(), initial: { to, cc: '', bcc: '', subject: '', body: '', markdown: false, attachments: [], inReplyTo: null, replaces: null }, title: 'New message' })
  const editDraft = async (id: string) => {
    try {
      const loaded = await call<LoadedDraft>(machine.id, 'email.draft', { id })
      setCompose({ key: Date.now(), initial: loaded, title: 'Draft' })
    } catch (error) { say((error as Error).message, true) }
  }
  useEffect(() => { if (params.draft && ready) void editDraft(params.draft) }, [params.draft, ready])
  const copyReference = async () => {
    const m = detail?.summary
    if (!m) return
    const subject = m.subject.replace(/[[\]]/g, '\\$&')
    const ref = `[${subject}](email:${m.id})`
    try {
      await navigator.clipboard.writeText(ref)
      say('copied reference')
    } catch (error) {
      say(`Couldn't copy: ${(error as Error).message}`, true)
    }
  }
  const toggleRead = async () => {
    const m = detail?.summary
    if (!m) return
    seenRef.current.add(m.id)
    await go('email.mark', { ids: [m.id], seen: !m.seen }).then(() => say(m.seen ? 'marked unread' : 'marked read'), (e: Error) => say(e.message, true))
  }
  const setFlag = async (flagged: boolean) => {
    const m = detail?.summary
    if (m) await go('email.mark', { ids: [m.id], flagged }).then(() => say(flagged ? 'flagged' : 'unflagged'), (e: Error) => say(e.message, true))
  }

  const onKey = (event: KeyboardEvent | React.KeyboardEvent) => {
    if (compose || isTyping(event.target)) return
    if (event.metaKey || event.altKey) return
    const key = event.key
    const ctrl = event.ctrlKey
    const handled = (() => {
      if (ctrl) {
        if (key === 'd') return frame.current?.scroll(0.5), true
        if (key === 'u') return frame.current?.scroll(-0.5), true
        if (key === 'r') return void go('email.refresh', {}).then(() => say('reloaded')), true
        return false
      }
      switch (key) {
        case 'k': case 'ArrowUp': next(); return true
        case 'j': case 'ArrowDown': back(); return true
        case ' ': frame.current?.scroll(event.shiftKey ? -0.9 : 0.9); return true
        case 'a': void onThread('archive'); return true
        case 's': void onThread('junk'); return true
        case 't': void onThread('trash'); return true
        case 'i': void onThread('ignore'); return true
        case 'x': void onThread('block'); return true
        case 'b': void onThread('receipt'); return true
        case 'n': void onThread('newsletter'); return true
        case 'u': void undo(); return true
        case 'r': void reply(); return true
        case 'R': setReader((r) => !r); return true
        case 'c': newMessage(); return true
        case '/': document.querySelector<HTMLInputElement>('.em-search input, input.em-search')?.focus(); return true
        case 'Escape': if (narrow) setNarrowView('list'); return narrow
        default: {
          const n = Number(key)
          if (n >= 1 && n <= 9) { const m = triage[n - 1]; if (m) { setMailboxRef(m.id); setSelected(undefined) } return Boolean(m) }
          return false
        }
      }
    })()
    if (handled) event.preventDefault()
  }

  const triage = state.prefs.mailboxes.map((ref) => findMailbox(state.mailboxes, ref)).filter((m): m is Mailbox => Boolean(m))
  const others = state.mailboxes.filter((m) => !triage.includes(m))

  if (!has(machine, 'ext:email')) return <PaneMessage>Email isn't set up on {machine.label}: start a thread with the email profile there.</PaneMessage>
  if (machine.state !== 'connected') return <PaneMessage>{machine.label} is offline.</PaneMessage>
  if (state.state === 'no-token') {
    return <PaneMessage>
      <div className="em-setup"><EnvelopeIcon size={28} />
        <p>Add your Fastmail API token in <b>Settings → Email</b>.</p>
        <p className="em-muted">Make one at fastmail.com → Settings → Privacy &amp; Security → Manage API tokens, with access to Email, Submission (to send) and Contacts.</p>
      </div>
    </PaneMessage>
  }
  if (state.state === 'error' && !state.mailboxes.length) return <PaneMessage>Couldn't reach Fastmail: {state.error} <Button onClick={() => void go('email.refresh', {})}>Retry</Button></PaneMessage>
  if (!ready) return <PaneMessage>Connecting to Fastmail…</PaneMessage>

  // The other mailboxes a message is in: Fastmail's labels.
  const labels = (m: Summary) => m.mailboxIds.filter((id) => id !== box?.id).map((id) => state.mailboxes.find((b) => b.id === id)).filter((b): b is Mailbox => Boolean(b))

  const showSidebar = wide || sidebar
  const showList = !narrow || narrowView === 'list'
  const showMessage = !narrow || narrowView === 'message'

  const sidebarEl = showSidebar && (
    <nav className="em-sidebar" aria-label="Mailboxes">
      <Button variant="primary" onClick={() => newMessage()}><PencilSimpleIcon size={14} /> New message</Button>
      <div className="em-boxes">
        {triage.map((m, i) => <MailboxRow key={m.id} mailbox={m} selected={m.id === box?.id && !query} hint={i < 9 ? String(i + 1) : undefined} onClick={() => { setMailboxRef(m.id); setQuery(''); setSearch(''); setSelected(undefined); setSidebar(false) }} />)}
        {others.length > 0 && <div className="em-boxes-label">Mailboxes</div>}
        {others.map((m) => <MailboxRow key={m.id} mailbox={m} selected={m.id === box?.id && !query} onClick={() => { setMailboxRef(m.id); setQuery(''); setSearch(''); setSelected(undefined); setSidebar(false) }} />)}
      </div>
      <div className="em-muted em-account">{state.username}</div>
    </nav>
  )

  const listEl = showList && (
    <section className="em-list" aria-label="Threads">
      <div className="em-list-head">
        {!wide && <button type="button" className="em-icon" aria-label="Mailboxes" onClick={() => setSidebar(!sidebar)}><EnvelopeIcon size={16} /></button>}
        <strong className="em-title">{query ? `Search${mailboxRef === '*' ? '' : ` in ${box ? mailboxName(box) : ''}`}` : box ? mailboxName(box) : ''}</strong>
        {box && !query && <span className="em-muted">{count(box.unread)}/{count(box.total)}</span>}
        <span className="em-spacer" />
        <button type="button" className="em-icon" aria-label="Refresh" title="Refresh (⌃R)" onClick={() => void go('email.refresh', {}).then(() => say('reloaded'))}><ArrowClockwiseIcon size={14} /></button>
      </div>
      <form className="em-search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setSelected(undefined) }}>
        <TextField value={search} placeholder={`Search ${box ? mailboxName(box) : 'mail'}`} onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setQuery('') }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setQuery(''); (e.target as HTMLInputElement).blur() } }} />
        {query && <button type="button" className="em-link" onClick={() => setMailboxRef(mailboxRef === '*' ? box?.id ?? 'inbox' : '*')}>{mailboxRef === '*' ? 'This mailbox' : 'All mail'}</button>}
      </form>
      <div className="em-rows" role="listbox" aria-label="Threads">
        {list.error && <div className="em-error">{list.error.message}</div>}
        {!list.data && list.loading && <div className="em-empty">Loading…</div>}
        {list.data && !threads.length && <div className="em-empty">{query ? 'Nothing found.' : `No messages in ${box ? mailboxName(box) : 'this mailbox'}.`}</div>}
        {threads.map((t) => <ThreadRow key={t.key} thread={t} labels={labels(t.latest)} selected={t.key === selected} onClick={() => select(t)} />)}
        {list.data && (list.data.ignored > 0 || showIgnored) && (
          <button type="button" className="em-link em-ignored" onClick={() => setShowIgnored(!showIgnored)}>
            {showIgnored ? 'Hide ignored' : `${list.data.ignored} ignored (flagged) thread${list.data.ignored === 1 ? '' : 's'}`}
          </button>
        )}
        {list.data && list.data.loaded < list.data.total && <div className="em-empty em-muted">Showing the newest {list.data.loaded} of {list.data.total}.</div>}
      </div>
    </section>
  )

  const allowed = detail ? matchSender(detail.summary.from, state.prefs.remoteImages) : undefined
  const remote = Boolean(detail && (allowed || remoteOnce === detail.summary.id))
  const fromEmail = detail ? senderEmail(detail.summary.from) : undefined
  const fromDomain = fromEmail ? senderDomain(fromEmail) : undefined
  const blocked = detail ? matchSender(detail.summary.from, state.prefs.blockedSenders) : undefined

  const messageEl = showMessage && (
    <section className="em-message" aria-label="Message">
      {compose ? <Composer key={compose.key} machine={machine} compose={compose} dark={theme.dark} onClose={() => setCompose(undefined)} onStatus={say} /> : <>
        <div className="em-toolbar">
          {narrow && <button type="button" className="em-icon" aria-label="Back to the list" onClick={() => setNarrowView('list')}><CaretLeftIcon size={16} /></button>}
          {isDrafts && detail
            ? <Button variant="primary" onClick={() => void editDraft(detail.summary.id)}><PencilSimpleIcon size={14} /> Edit draft</Button>
            : <>
              <Tool label="Reply" keys="r" icon={<ReplyIcon />} onClick={() => void reply()} disabled={!detail} />
              <Tool label="Reply all" icon={<ReplyAllIcon />} onClick={() => void reply(true)} disabled={!detail} />
              <Tool label="Forward" icon={<ForwardIcon />} onClick={() => void reply(false, true)} disabled={!detail} />
            </>}
          <span className="em-sep" />
          <Tool label="Archive" keys="a" icon={<ArchiveIcon size={16} />} onClick={() => void onThread('archive')} disabled={!detail || box?.role === 'archive'} />
          <Tool label="Junk" keys="s" icon={<ShieldWarningIcon size={16} />} onClick={() => void onThread('junk')} disabled={!detail || box?.role === 'junk'} />
          <Tool label="Trash" keys="t" icon={<TrashIcon />} onClick={() => void onThread('trash')} disabled={!detail || box?.role === 'trash'} />
          <Tool label="Ignore (flag and hide)" keys="i" icon={<FlagIcon />} onClick={() => void onThread('ignore')} disabled={!detail} />
          <Menu.Root>
            <Menu.Trigger className="em-tool" aria-label="More" disabled={!detail}>More ▾</Menu.Trigger>
            <Menu.Popup>
              <Menu.Item onClick={() => void onThread('newsletter')}><NewsIcon size={14} /> File newsletter (n)</Menu.Item>
              <Menu.Item onClick={() => void onThread('receipt')}><ReceiptIcon size={14} /> File receipt (b)</Menu.Item>
              <Menu.Separator />
              <Menu.Item onClick={() => void toggleRead()}>{detail?.summary.seen ? 'Mark unread' : 'Mark read'}</Menu.Item>
              <Menu.Item onClick={() => void setFlag(!detail?.summary.flagged)}>{detail?.summary.flagged ? 'Unflag' : 'Flag'}</Menu.Item>
              <Menu.Separator />
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger>Move to</Menu.SubmenuTrigger>
                <Menu.SubmenuPopup>
                  {state.mailboxes.filter((m) => m.id !== box?.id && m.role !== 'drafts').map((m) => (
                    <Menu.Item key={m.id} onClick={() => void onThread('move', m.id)}>{mailboxName(m)}</Menu.Item>
                  ))}
                </Menu.SubmenuPopup>
              </Menu.SubmenuRoot>
              <Menu.Separator />
              {fromEmail && (blocked
                ? <Menu.Item onClick={() => void go('email.unblock', { sender: blocked }).then(() => say(`unblocked ${blocked}`))}>Unblock {blocked}</Menu.Item>
                : <>
                  <Menu.Item onClick={() => void onThread('block')}>Block {fromEmail} (x)</Menu.Item>
                  {fromDomain && <Menu.Item onClick={() => void onThread('block-domain')}>Block {fromDomain}</Menu.Item>}
                </>)}
              {fromEmail && <Menu.Item onClick={() => { setSearch(`from:${fromEmail}`); setQuery(`from:${fromEmail}`); setMailboxRef('*') }}>Mail from {fromEmail}</Menu.Item>}
              {fromEmail && <Menu.Item onClick={() => void navigator.clipboard?.writeText(fromEmail).then(() => say('copied'))}>Copy sender address</Menu.Item>}
            </Menu.Popup>
          </Menu.Root>
          <span className="em-spacer" />
          {state.undo && <Tool label={`Undo ${state.undo}`} keys="u" icon={<ArrowCounterClockwiseIcon size={16} />} onClick={() => void undo()} />}
          <Tool label="Copy reference" icon={<CopyIcon size={16} />} onClick={() => void copyReference()} disabled={!detail} />
          <Tool label={reader ? 'Show original' : 'Reader mode'} keys="⇧R" icon={<BookIcon />} pressed={reader} onClick={() => setReader(!reader)} disabled={!detail} />
        </div>
        {status && <div className={status.error ? 'em-status em-status-error' : 'em-status'} role="status">{status.text}{status.error && <button type="button" className="em-link" onClick={() => setStatus(undefined)}>×</button>}</div>}
        {!viewing && <div className="em-empty em-grow">{threads.length ? 'No message selected.' : 'All done.'}</div>}
        {viewing && detailState.error && !detail && <div className="em-error em-grow">Couldn't load the message: {detailState.error.message} <Button onClick={detailState.refetch}>Retry</Button></div>}
        {viewing && !detail && !detailState.error && <div className="em-empty em-grow">Loading…</div>}
        {detail && <>
          <header className="em-header">
            <h2 className="em-subject">{detail.summary.subject}</h2>
            <div className="em-from">
              <Avatar addr={detail.summary.from[0]} size={40} />
              <div className="em-from-text">
                <div><strong>{detail.summary.from[0]?.name || detail.summary.from[0]?.email || '-'}</strong>{detail.summary.from[0]?.name && <span className="em-muted"> {detail.summary.from[0]?.email}</span>}</div>
                {detail.summary.to.length > 0 && <div className="em-muted em-clip" title={detail.summary.to.map(displayAddr).join(', ')}>To: {detail.summary.to.map((a) => a.name || a.email).join(', ')}</div>}
                {detail.summary.cc.length > 0 && <div className="em-muted em-clip" title={detail.summary.cc.map(displayAddr).join(', ')}>Cc: {detail.summary.cc.map((a) => a.name || a.email).join(', ')}</div>}
                {labels(detail.summary).length > 0 && <div className="em-labels">{labels(detail.summary).map((m) => <Label key={m.id} mailbox={m} />)}</div>}
              </div>
              <div className="em-when">
                <span className="em-muted">{longDate(detail.summary.receivedAt)}</span>
                {detail.summary.answered && <span className="em-muted em-small"><ReplyIcon size={12} /> You already replied</span>}
                {theme.dark && darkens(detail.html) && !reader && <button type="button" className="em-link em-small" onClick={() => setLightPaper(!lightPaper)}>{lightPaper ? 'Dark background' : 'Light background'}</button>}
              </div>
            </div>
            {detail.thread.length > 1 && (
              <div className="em-thread">
                <button type="button" className="em-link em-small" onClick={() => setShowThread(!showThread)}>{showThread ? '▾' : '▸'} {detail.thread.length} messages in this conversation</button>
                {showThread && detail.thread.map((m) => (
                  <button type="button" key={m.id} className={m.id === viewing ? 'em-thread-row em-selected' : 'em-thread-row'} onClick={() => setViewing(m.id)}>
                    <span>{senderLabel(m.from)}</span><span className="em-muted em-clip">{m.preview}</span><span className="em-muted">{shortDate(m.receivedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </header>
          {hasRemoteContent(detail.html) && (
            <div className="em-banner">
              <span className="em-muted">{allowed ? `Remote content is always loaded from ${allowed}.` : remote ? 'Remote content loaded for this message.' : 'This message contains remote content.'}</span>
              <span className="em-spacer" />
              {!remote && <Button onClick={() => setRemoteOnce(detail.summary.id)}>Load remote content</Button>}
              <Menu.Root>
                <Menu.Trigger className="em-tool" aria-label="Remote content options">⋯</Menu.Trigger>
                <Menu.Popup>
                  {allowed
                    ? <Menu.Item onClick={() => void go('email.allowRemote', { sender: allowed, allow: false })}>Stop always loading from {allowed}</Menu.Item>
                    : <>
                      {fromEmail && <Menu.Item onClick={() => void go('email.allowRemote', { sender: fromEmail, allow: true })}>Always load from {fromEmail}</Menu.Item>}
                      {fromDomain && <Menu.Item onClick={() => void go('email.allowRemote', { sender: fromDomain, allow: true })}>Always load from {fromDomain}</Menu.Item>}
                    </>}
                </Menu.Popup>
              </Menu.Root>
            </div>
          )}
          {detail.html.trim() || detail.text.trim()
            ? <MessageFrame detail={detail} remote={remote} lightPaper={lightPaper} reader={reader} dark={theme.dark} systemDark={theme.systemDark} palette={theme.palette} onKey={onKey} handle={frame} />
            : <div className="em-empty em-grow">(no text body)</div>}
          {detail.attachments.length > 0 && (
            <div className="em-attachments em-strip">
              {detail.attachments.map((a) => (
                <button type="button" key={a.blobId + a.name} className="em-chip" title={`Download ${a.name}`} onClick={() => void download(machine.id, a).catch((e: Error) => say(e.message, true))}>
                  <PaperclipIcon size={12} /> {a.name} <span className="em-muted">{size(a.size)}</span>
                </button>
              ))}
            </div>
          )}
        </>}
      </>}
    </section>
  )

  return (
    <div className={`em${narrow ? ' em-narrow' : ''}`} ref={setRoot} tabIndex={-1} data-focus onKeyDown={onKey}>
      {sidebarEl}
      {listEl}
      {messageEl}
    </div>
  )
}

function Tool({ label, keys, icon, onClick, disabled, pressed }: { label: string; keys?: string; icon: ReactNode; onClick(): void; disabled?: boolean; pressed?: boolean }) {
  return (
    <button type="button" className={pressed ? 'em-tool em-pressed' : 'em-tool'} aria-label={label} aria-pressed={pressed} title={keys ? `${label} (${keys})` : label} disabled={disabled} onClick={onClick}>{icon}</button>
  )
}

function MailboxRow({ mailbox, selected, hint, onClick }: { mailbox: Mailbox; selected: boolean; hint?: string; onClick(): void }) {
  return (
    <button type="button" className={selected ? 'em-box em-selected' : 'em-box'} onClick={onClick} title={hint ? `${mailboxName(mailbox)} (${hint})` : mailboxName(mailbox)}>
      <span className="em-clip">{mailboxName(mailbox)}</span>
      {mailbox.unread > 0 && <span className="em-count">{count(mailbox.unread)}</span>}
    </button>
  )
}

function ThreadRow({ thread, labels, selected, onClick }: { thread: Thread; labels: Mailbox[]; selected: boolean; onClick(): void }) {
  const m = thread.latest
  return (
    <div role="option" aria-selected={selected} data-thread={thread.key} className={`em-row${selected ? ' em-selected' : ''}${thread.unread ? ' em-unread' : ''}`} onClick={onClick}>
      <Avatar addr={m.from[0]} size={30} />
      <div className="em-row-main">
        <div className="em-row-line">
          <span className="em-sender em-clip">{m.draft ? `To ${m.to.map((a) => a.name || a.email).join(', ')}` : senderLabel(m.from)}</span>
          <span className="em-marks">
            {m.answered && <span title="Replied"><ReplyIcon size={11} /></span>}
            {thread.hasAttachment && <span title="Has attachment"><PaperclipIcon size={11} /></span>}
            {thread.flagged && <span className="em-flag" title="Flagged"><FlagIcon size={11} /></span>}
            {thread.unread && <span className="em-dot" title="Unread" />}
          </span>
          <span className="em-muted em-date">{shortDate(m.receivedAt)}</span>
        </div>
        <div className="em-row-line">
          <span className="em-row-subject em-clip">{m.subject}</span>
          {thread.messages.length > 1 && <span className="em-thread-count">{thread.messages.length}</span>}
        </div>
        {m.preview && <div className="em-preview-text">{m.preview.replace(/\s+/g, ' ')}</div>}
        {labels.length > 0 && <div className="em-labels">{labels.map((b) => <Label key={b.id} mailbox={b} />)}</div>}
      </div>
    </div>
  )
}

// The inbox's unread count, in the thread's header.

function UnreadPill({ machine, thread }: ViewProps<'thread'>) {
  const state = useValue<EmailState>(machine, STATE)
  const dispatch = useDispatch()
  if (!state || state.state !== 'ready') return null
  const inbox = roleMailbox(state.mailboxes, 'inbox')
  if (!inbox) return null
  return (
    <button type="button" className="em-pill" title={`${inbox.unread} unread of ${inbox.total} in Inbox`}
      onClick={() => void dispatch('pane.open', { thread: thread.id, kind: PANE }, { machine: machine.id })}>
      <EnvelopeIcon size={13} /> {count(inbox.unread)}<span className="em-muted">/{count(inbox.total)}</span>
    </button>
  )
}

// Over the composer: the agent wants to send.

function PendingSends({ machine, thread }: SlotProps['composer.above']) {
  const sends = useValue<PendingSend[]>(machine, PENDING, { scope: thread.id })
  const dispatch = useDispatch()
  const [busy, setBusy] = useState(false)
  const send = sends?.[0]
  if (!send) return null
  const answer = (value: 'send' | 'always' | 'cancel') => {
    setBusy(true)
    void dispatch('email.answer', { thread: thread.id, id: send.id, answer: value }, { machine: machine.id }).finally(() => setBusy(false))
  }
  return (
    <div className="em-confirm" role="dialog" aria-label="Send this email?">
      <div className="em-confirm-head"><EnvelopeIcon size={14} /> <strong>Send this email?</strong>{send.archive && <span className="em-muted"> and archive its thread</span>}</div>
      <dl className="em-confirm-fields">
        {send.from && <><dt>From</dt><dd>{send.from}</dd></>}
        <dt>To</dt><dd>{send.to || '—'}</dd>
        {send.cc && <><dt>Cc</dt><dd>{send.cc}</dd></>}
        <dt>Subject</dt><dd>{send.subject || '(no subject)'}</dd>
        {send.attachments.length > 0 && <><dt>Attached</dt><dd>{send.attachments.join(', ')}</dd></>}
      </dl>
      <pre className="em-confirm-body">{send.body}</pre>
      <div className="em-compose-bar">
        <button type="button" className="em-link" onClick={() => void dispatch('pane.open', { thread: thread.id, kind: PANE, params: { draft: send.draftId } }, { machine: machine.id })}>Open in Email</button>
        <span className="em-spacer" />
        <Button disabled={busy} onClick={() => answer('cancel')}>Don't send</Button>
        <Button disabled={busy} onClick={() => answer('always')}>Send, and don't ask again here</Button>
        <Button variant="primary" disabled={busy} onClick={() => answer('send')}>Send</Button>
      </div>
    </div>
  )
}

const VERBS: Record<string, [string, string, string]> = {
  email_mailboxes: ['Listed mailboxes', 'Listing mailboxes', 'Couldn’t list mailboxes'],
  email_list: ['Listed', 'Listing', 'Couldn’t list'],
  email_search: ['Searched mail', 'Searching mail', 'Search failed'],
  email_read: ['Read email', 'Reading email', 'Couldn’t read email'],
  email_move: ['Moved', 'Moving', 'Couldn’t move'],
  email_mark: ['Marked', 'Marking', 'Couldn’t mark'],
  email_undo: ['Undid', 'Undoing', 'Couldn’t undo'],
  email_block_sender: ['Blocked sender', 'Blocking sender', 'Couldn’t block'],
  email_file_newsletter: ['Filed newsletter', 'Filing newsletter', 'Couldn’t file'],
  email_file_receipt: ['Filed receipt', 'Filing receipt', 'Couldn’t file'],
  email_draft: ['Drafted', 'Drafting', 'Couldn’t draft'],
  email_send: ['Sent', 'Waiting to send', 'Not sent'],
  email_delete_draft: ['Deleted draft', 'Deleting draft', 'Couldn’t delete'],
  email_save_attachment: ['Saved attachment', 'Saving attachment', 'Couldn’t save'],
}
function subject({ call: c }: ToolRowCall): ReactNode {
  const a = c.arguments as Record<string, unknown>
  if (c.name === 'email_list') return String(a.mailbox ?? 'inbox')
  if (c.name === 'email_search') return [a.query, a.from && `from:${a.from}`, a.subject && `subject:${a.subject}`].filter(Boolean).join(' ') || null
  if (c.name === 'email_move') return `${(a.ids as string[] | undefined)?.length ?? 0} → ${String(a.to ?? '')}`
  if (c.name === 'email_draft') return String(a.subject ?? (a.reply_to ? 'reply' : a.forward ? 'forward' : ''))
  return null
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.style(STYLE)
    superego.pane(PANE, { title: 'Email', icon: EnvelopeIcon, menu: true, component: EmailPane, width: 0.6 })
    superego.view('email.unread', { title: 'Inbox', icon: EnvelopeIcon, context: 'thread', fits: ['header'], default: 'header', component: UnreadPill })
    superego.slot('composer.above', PendingSends)
    // `email:<id>` links (copied from the toolbar or written by the agent) open that message in the Email pane.
    superego.link({
      match: 'email:',
      async open(href, { machine, thread }) {
        const id = href.slice('email:'.length).trim()
        if (!machine || !thread || !id) return 'not an email'
        await superego.dispatch('pane.open', { thread: thread.id, kind: PANE, params: { message: id } }, { machine })
        return undefined
      },
      target: (href) => `email ${href.slice('email:'.length)}`,
    })
    // A profile's window action: offered only while one of its threads is shown.
    superego.action(defineAction({
      id: 'email.show', title: 'Show mail', keys: 'mod+shift+e',
      when: (context) => Boolean(context.selection?.thread),
      run: (_params, context) => context.selection && context.dispatch('pane.open', { thread: context.selection.thread, kind: PANE }, { machine: context.selection.machine }),
    }))
    for (const [name, verbs] of Object.entries(VERBS)) superego.tool(name, { icon: EnvelopeIcon, verbs, subject, phrase: (n) => `used email ${n === 1 ? 'once' : `${n} times`}` })
  },
})

const STYLE = `
.em { display: flex; flex: 1 1 auto; width: 100%; height: 100%; min-width: 0; min-height: 0; outline: none; font-size: 13px; color: var(--superego-text); }
.em-muted { color: var(--superego-muted); }
.em-small { font-size: 11px; }
.em-spacer { flex: 1; }
.em-clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.em-grow { flex: 1; }
.em-link { background: none; border: 0; padding: 0 2px; color: var(--superego-accent); cursor: pointer; font: inherit; }
.em-icon, .em-tool { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 28px; height: 28px; padding: 0 6px; border: 0; border-radius: var(--superego-radius); background: none; color: inherit; cursor: pointer; font: inherit; }
.em-icon:hover, .em-tool:hover:not(:disabled) { background: var(--superego-hover); }
.em-tool:disabled { opacity: 0.4; cursor: default; }
.em-pressed { background: var(--superego-selected); }
.em-sep { width: 1px; height: 18px; background: var(--superego-border); margin: 0 4px; }
.em-setup { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; max-width: 420px; }
.em-sidebar { width: 190px; flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 8px; border-right: 1px solid var(--superego-border); overflow: auto; }
.em-boxes { display: flex; flex-direction: column; gap: 1px; }
.em-boxes-label { margin: 10px 8px 2px; font-size: 11px; color: var(--superego-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.em-box { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 0; border-radius: var(--superego-radius); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.em-box:hover { background: var(--superego-hover); }
.em-selected { background: var(--superego-selected) !important; }
.em-count { margin-left: auto; font-size: 11px; color: var(--superego-muted); font-variant-numeric: tabular-nums; }
.em-account { margin-top: auto; padding: 0 8px; font-size: 11px; }
.em-list { width: 340px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--superego-border); }
.em-narrow .em-list { width: 100%; border-right: 0; }
.em-list-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 4px; }
.em-title { font-size: 14px; }
.em-search { display: flex; gap: 6px; align-items: center; padding: 4px 10px 8px; }
.em-search input { flex: 1; }
.em-rows { flex: 1; overflow: auto; }
.em-row { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--superego-border) 50%, transparent); cursor: pointer; }
.em-row:hover { background: var(--superego-hover); }
.em-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.em-row-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.em-sender { flex: 1; }
.em-unread .em-sender { font-weight: 600; }
.em-unread .em-row-subject { font-weight: 500; }
.em-row-subject { flex: 1; color: var(--superego-text); }
.em-date { flex: none; font-size: 12px; }
.em-marks { display: inline-flex; gap: 3px; align-items: center; color: var(--superego-muted); }
.em-flag { color: #f59e0b; }
.em-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--superego-accent); }
.em-thread-count { font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 99px; background: var(--superego-raised); color: var(--superego-muted); }
.em-preview-text { color: var(--superego-muted); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.em-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.em-label { font-size: 10px; font-weight: 500; padding: 0 6px; border-radius: 99px; }
.em-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: white; font-weight: 600; }
.em-ignored { padding: 10px; display: block; }
.em-empty { padding: 24px; text-align: center; color: var(--superego-muted); }
.em-error { padding: 8px 12px; color: var(--superego-status-error, #d33); }
.em-message { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.em-toolbar { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--superego-border); flex-wrap: wrap; }
.em-status { padding: 4px 12px; font-size: 12px; color: var(--superego-muted); border-bottom: 1px solid var(--superego-border); }
.em-status-error { color: var(--superego-status-error, #d33); }
.em-header { padding: 14px 20px 10px; border-bottom: 1px solid var(--superego-border); display: flex; flex-direction: column; gap: 10px; }
.em-subject { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; user-select: text; }
.em-from { display: flex; gap: 10px; align-items: flex-start; }
.em-from-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; user-select: text; }
.em-when { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
.em-thread { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.em-thread-row { align-self: stretch; }
.em-thread-row { display: grid; grid-template-columns: minmax(80px, 160px) 1fr auto; gap: 8px; padding: 4px 8px; border: 0; border-radius: var(--superego-radius); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.em-thread-row:hover { background: var(--superego-hover); }
.em-banner { display: flex; align-items: center; gap: 8px; padding: 4px 20px; font-size: 12px; background: color-mix(in srgb, var(--superego-muted) 8%, transparent); border-bottom: 1px solid var(--superego-border); }
.em-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: transparent; display: block; }
.em-attachments { display: flex; flex-wrap: wrap; gap: 6px; }
.em-strip { padding: 8px 20px; border-top: 1px solid var(--superego-border); }
.em-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--superego-border); border-radius: 99px; background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.em-compose { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; min-height: 0; }
.em-compose-head { display: flex; gap: 8px; align-items: baseline; }
.em-field { display: flex; align-items: center; gap: 8px; }
.em-field > span { width: 56px; flex: none; color: var(--superego-muted); }
.em-field input { flex: 1; }
.em-body { flex: 1; min-height: 160px; resize: none; padding: 10px; border: 1px solid var(--superego-border); border-radius: var(--superego-radius); background: var(--superego-bg); color: inherit; font: 14px/1.5 var(--superego-font); }
.em-preview { border: 1px solid var(--superego-border); border-radius: var(--superego-radius); }
.em-compose-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.em-button-like { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 4px 8px; border-radius: var(--superego-radius); }
.em-button-like:hover { background: var(--superego-hover); }
.em-pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border: 1px solid var(--superego-border); border-radius: 99px; background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
.em-confirm { margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--superego-accent); border-radius: var(--superego-radius-lg, 10px); background: var(--superego-raised); display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.em-confirm-head { display: flex; align-items: center; gap: 6px; }
.em-confirm-fields { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
.em-confirm-fields dt { color: var(--superego-muted); }
.em-confirm-fields dd { margin: 0; overflow-wrap: anywhere; }
.em-confirm-body { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font: 12px/1.45 var(--superego-mono); padding: 8px; border-radius: var(--superego-radius); background: var(--superego-bg); }
`
