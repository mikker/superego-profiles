// What email is, for both halves (spread into each), and the names and shapes they share.

/** The pane: mailboxes, a mailbox's threads, a message, and the composer. A pane kind of this id. */
export const PANE = 'email'
/** The account as it stands (`EmailState`): a live value. */
export const STATE = 'email.state'
/** Sends waiting on the user's yes, per thread (`PendingSend[]`): a scoped value. */
export const PENDING = 'email.pending'

export const about = {
  name: 'email', version: '0.2.0', api: '^5.8', title: 'Email',
  description: 'Your Fastmail account over JMAP: a mail pane, and tools for the agent to read, triage and write email.',
  panes: {
    [PANE]: "the user's Fastmail: mailboxes, a mailbox's threads, one message rendered, and a composer. Params (all optional): { mailbox } a mailbox name or role (inbox, archive, drafts, sent, junk, trash), { message } a message id to show, { draft } a draft's id to open in the composer, { search } words to search for",
  },
}

export type Addr = { name: string; email: string }

export type Mailbox = {
  id: string
  name: string
  /** JMAP's role: `inbox`, `archive`, `drafts`, `sent`, `junk`, `trash`, … or null for the user's own. */
  role: string | null
  parentId: string | null
  sortOrder: number
  total: number
  unread: number
}

/** A message as a list shows it. */
export type Summary = {
  id: string
  threadId: string
  mailboxIds: string[]
  subject: string
  from: Addr[]
  to: Addr[]
  cc: Addr[]
  replyTo: Addr[]
  /** ISO dates. */
  receivedAt: string
  sentAt: string | null
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  preview: string
  hasAttachment: boolean
}

/** A conversation in one mailbox: its messages there, oldest first. `latest` is the one shown. */
export type Thread = {
  /** `t:<threadId>`, or `m:<id>` for a message without one. */
  key: string
  messages: Summary[]
  latest: Summary
  unread: boolean
  flagged: boolean
  hasAttachment: boolean
}

export type ListResult = {
  mailboxId: string
  /** Newest first. */
  threads: Thread[]
  /** Messages in the mailbox (or matching the search), and how many of them were loaded. */
  total: number
  loaded: number
  /** Threads left out because they're ignored (flagged). */
  ignored: number
  /** Said when blocked senders' mail was just moved to Junk. */
  note?: string
}

export type Attachment = { blobId: string; name: string; type: string; size: number; partId: string | null }

/** A message to read: its bodies (inline images already `data:` URIs), attachments, and its whole conversation. */
export type Detail = {
  summary: Summary
  /** The HTML body, or '' when it has none. `cid:` images point at `data:` URIs. */
  html: string
  text: string
  attachments: Attachment[]
  /** Every message of its conversation, in any mailbox, oldest first. */
  thread: Summary[]
}

/** A draft as the composer edits it. */
export type DraftInput = {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  markdown: boolean
  attachments: Attachment[]
  /** The message it answers (a JMAP email id): threads it and, sent, can archive that thread. */
  inReplyTo: string | null
  /** The saved copy it replaces in Drafts. */
  replaces: string | null
}

export type LoadedDraft = DraftInput & { id: string }

export type EmailState = {
  /** `no-token`: nothing to sign in with yet. */
  state: 'no-token' | 'connecting' | 'ready' | 'error'
  error?: string
  username?: string
  mailboxes: Mailbox[]
  /** Moves on whenever mail changes (ours, or the server's push): lists and messages read again. */
  version: number
  /** What Undo would undo, in words; null when nothing. */
  undo: string | null
  syncedAt?: number
  prefs: Prefs
}

/** The settings the pane needs to know. */
export type Prefs = {
  /** Mailboxes on top of the sidebar, in order: triage keys go through them (⌘1…). */
  mailboxes: string[]
  blockedSenders: string[]
  remoteImages: string[]
  senderEmail: string
  newslettersMailbox: string
}

/** A send the agent asked for, waiting on the user. */
export type PendingSend = {
  id: string
  draftId: string
  from: string
  to: string
  cc: string
  subject: string
  body: string
  attachments: string[]
  archive: boolean
}

export const NO_PREFS: Prefs = { mailboxes: ['INBOX'], blockedSenders: [], remoteImages: [], senderEmail: '', newslettersMailbox: 'Newsletters' }
export const NO_STATE: EmailState = { state: 'connecting', mailboxes: [], version: 0, undo: null, prefs: NO_PREFS }

/** A thread action: what the pane's buttons and keys do, and the agent's email_move. */
export type MoveMode = 'archive' | 'junk' | 'trash' | 'ignore' | 'move'

// Sender rules, as Snailblaze has them: an entry is a whole address or a domain (which covers its subdomains).

export const normalizeSender = (value: string) => value.trim().toLowerCase().replace(/^@+/, '')
export const senderEmail = (from: Addr[]) => {
  const address = from.find((a) => a.email.trim())
  return address ? normalizeSender(address.email) : undefined
}
export const senderDomain = (email: string) => {
  const at = email.lastIndexOf('@')
  return at > 0 ? normalizeSender(email.slice(at + 1)) || undefined : undefined
}
/** The entry of `list` that matches this sender (its address, or its domain or a parent of it), if any. */
export function matchSender(from: Addr[], list: string[]): string | undefined {
  const entries = list.map(normalizeSender).filter(Boolean)
  for (const address of from) {
    const email = normalizeSender(address.email)
    if (!email) continue
    if (entries.includes(email)) return email
    const domain = senderDomain(email)
    if (!domain) continue
    const hit = entries.find((entry) => !entry.includes('@') && (domain === entry || domain.endsWith(`.${entry}`)))
    if (hit) return hit
  }
  return undefined
}

export const displayAddr = (a: Addr) => {
  const name = a.name.trim()
  const email = a.email.trim()
  return name && email ? `${name} <${email}>` : name || email
}
export const formatAddrs = (list: Addr[]) => list.map((a) => {
  const name = a.name.replace(/"/g, '').trim()
  const email = a.email.trim()
  if (!name || name === email) return email
  return /[,;<>@]/.test(name) ? `"${name}" <${email}>` : `${name} <${email}>`
}).filter(Boolean).join(', ')

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
/** A To or Cc field as typed: commas or semicolons between entries, each `Name <email>` or a bare email. */
export function parseAddrs(text: string): { addrs: Addr[]; invalid: string[] } {
  const entries: string[] = []
  let current = ''
  let quoted = false
  let bracketed = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) bracketed = true
    else if (ch === '>' && !quoted) bracketed = false
    else if ((ch === ',' || ch === ';') && !quoted && !bracketed) { entries.push(current); current = ''; continue }
    current += ch
  }
  entries.push(current)
  const addrs: Addr[] = []
  const invalid: string[] = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const angled = /^(.*)<([^<>]+)>\s*$/.exec(entry)
    const email = (angled ? angled[2]! : entry).trim()
    const name = angled ? angled[1]!.trim().replace(/^"(.*)"$/, '$1').trim() : ''
    if (EMAIL.test(email)) addrs.push({ name, email })
    else invalid.push(entry)
  }
  return { addrs, invalid }
}

export const replySubject = (subject: string) => {
  const s = subject.trim()
  if (!s) return 'Re: (no subject)'
  return /^re:/i.test(s) ? s : `Re: ${s}`
}
export const forwardSubject = (subject: string) => {
  const s = subject.trim()
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`
}

/** `Mon, 03 Mar 2025 09:41:00 +0100`, as Snailblaze writes a reply's attribution. */
export function replyDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown date'
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

/** The body a reply starts with: two blank lines, the attribution, the original quoted. */
export function replyBody(detail: { summary: Summary; text: string; html: string }): string {
  const from = detail.summary.from.map(displayAddr).filter(Boolean).join(', ') || 'unknown sender'
  const quoted = detail.text.trim()
    ? detail.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
    : detail.html.trim() ? '> [Original rich-text body omitted for privacy.]' : '>'
  return `\n\nOn ${replyDate(detail.summary.receivedAt || detail.summary.sentAt || '')}, ${from} wrote:\n${quoted}\n`
}

/** The key a message's thread is grouped under. */
export const threadKey = (m: Summary) => m.threadId.trim() ? `t:${m.threadId}` : `m:${m.id}`
const time = (m: Summary) => Date.parse(m.receivedAt || m.sentAt || '') || 0

/** Group a mailbox's messages into threads, newest first, each oldest message first; ignored (flagged) ones apart. */
export function groupThreads(messages: Summary[], { ignoreFlagged }: { ignoreFlagged: boolean }): { threads: Thread[]; ignored: number } {
  const byKey = new Map<string, Summary[]>()
  for (const m of messages) {
    const key = threadKey(m)
    const list = byKey.get(key)
    if (list) list.push(m)
    else byKey.set(key, [m])
  }
  let ignored = 0
  const threads: Thread[] = []
  for (const [key, list] of byKey) {
    list.sort((a, b) => time(a) - time(b) || (a.id < b.id ? -1 : 1))
    const latest = list[list.length - 1]!
    const thread: Thread = {
      key, messages: list, latest,
      unread: list.some((m) => !m.seen), flagged: list.some((m) => m.flagged), hasAttachment: list.some((m) => m.hasAttachment),
    }
    if (ignoreFlagged && latest.flagged) { ignored++; continue }
    threads.push(thread)
  }
  threads.sort((a, b) => time(b.latest) - time(a.latest) || (a.latest.id < b.latest.id ? 1 : -1))
  return { threads, ignored }
}

/** How a sidebar or a tool names a mailbox: JMAP servers call the inbox INBOX. */
export const mailboxName = (m: Mailbox) => m.role === 'inbox' ? 'Inbox' : m.name

/** The mailbox a name, a role or an id refers to. */
export function findMailbox(mailboxes: Mailbox[], ref: string): Mailbox | undefined {
  const want = ref.trim().toLowerCase()
  if (!want) return undefined
  return mailboxes.find((m) => m.id === ref)
    ?? mailboxes.find((m) => m.role === want)
    ?? mailboxes.find((m) => m.name.toLowerCase() === want)
    ?? (want === 'inbox' ? mailboxes.find((m) => m.name.toLowerCase() === 'inbox') : undefined)
}

const FALLBACK: Record<string, string[]> = {
  inbox: ['INBOX', 'Inbox'], archive: ['Archive', 'All Mail'], junk: ['Junk', 'Spam', 'Junk Mail'],
  trash: ['Trash', 'Deleted Messages', 'Bin'], drafts: ['Drafts'], sent: ['Sent', 'Sent Items', 'Sent Messages'],
}
/** A standard mailbox by its role, else by the names it usually has. */
export function roleMailbox(mailboxes: Mailbox[], role: string): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role)
    ?? (FALLBACK[role] ?? []).map((name) => mailboxes.find((m) => m.name.toLowerCase() === name.toLowerCase())).find(Boolean)
}

/**
 * Search words as JMAP filter conditions: `from:`, `to:`, `subject:`, `is:unread`, `is:read`, `is:flagged`,
 * `has:attachment`, `after:` and `before:` (dates), quotes to keep words together; the rest searches everywhere.
 */
export function searchConditions(search: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const words: string[] = []
  for (const m of search.matchAll(/(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g)) {
    const value = (m[2] ?? m[3] ?? '').replace(/^"|"$/g, '')
    const key = m[1]?.toLowerCase()
    if (!key) { words.push(value); continue }
    if (key === 'from' || key === 'to' || key === 'cc' || key === 'subject' || key === 'body') out.push({ [key]: value })
    else if (key === 'is' && value === 'unread') out.push({ notKeyword: '$seen' })
    else if (key === 'is' && value === 'read') out.push({ hasKeyword: '$seen' })
    else if (key === 'is' && (value === 'flagged' || value === 'starred')) out.push({ hasKeyword: '$flagged' })
    else if (key === 'has' && value.startsWith('attach')) out.push({ hasAttachment: true })
    else if ((key === 'after' || key === 'before') && !Number.isNaN(Date.parse(value))) out.push({ [key]: new Date(value).toISOString() })
    else words.push(m[0])
  }
  if (words.length) out.push({ text: words.join(' ') })
  return out
}
