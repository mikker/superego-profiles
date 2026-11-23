// A JMAP client for Fastmail (any JMAP server, given its session URL), as Snailblaze talks to it: a bearer token, the
// session once, then batches of method calls. Reading, triage (moves and keywords), drafts, sending and contacts.
// No state but the session; the daemon half keeps the rest.
import { randomUUID } from 'node:crypto'
import {
  groupThreads, matchSender, parseAddrs, roleMailbox, searchConditions, type Addr, type Attachment, type Detail, type DraftInput,
  type ListResult, type LoadedDraft, type Mailbox, type Summary,
} from './shared.ts'
import { renderMarkdown } from './markdown.ts'

export const FASTMAIL_SESSION = 'https://api.fastmail.com/jmap/session'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const SUBMISSION = 'urn:ietf:params:jmap:submission'
const CONTACTS = 'urn:ietf:params:jmap:contacts'

type Session = {
  apiUrl: string
  downloadUrl: string
  uploadUrl: string
  eventSourceUrl?: string
  username?: string
  capabilities: Record<string, unknown>
  primaryAccounts: Record<string, string>
}

type Call = [name: string, args: Record<string, unknown>, tag: string]
type Raw = Record<string, any>

export class JmapError extends Error {
  readonly type: string | undefined
  constructor(message: string, type?: string) { super(message); this.type = type }
}

/** What a thread action left behind: the messages moved, so Undo can put them back. */
export type Entry = { id: string; mailboxIds: string[]; flagged: boolean; seen: boolean }

const SUMMARY_PROPERTIES = [
  'id', 'threadId', 'subject', 'from', 'to', 'cc', 'replyTo', 'mailboxIds', 'keywords', 'receivedAt', 'sentAt', 'preview', 'hasAttachment',
]

/** JSON Pointer escaping for a patch's path (`mailboxIds/<id>`). */
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')
const addrs = (list: unknown): Addr[] => Array.isArray(list)
  ? list.map((a: Raw) => ({ name: String(a?.name ?? '').trim(), email: String(a?.email ?? '').trim() })).filter((a) => a.email || a.name)
  : []

export function toSummary(item: Raw): Summary {
  const keywords = (item.keywords ?? {}) as Record<string, boolean>
  return {
    id: String(item.id),
    threadId: String(item.threadId ?? ''),
    mailboxIds: Object.entries((item.mailboxIds ?? {}) as Record<string, boolean>).filter(([, on]) => on).map(([id]) => id),
    subject: String(item.subject ?? '').trim() || '(no subject)',
    from: addrs(item.from), to: addrs(item.to), cc: addrs(item.cc), replyTo: addrs(item.replyTo),
    receivedAt: String(item.receivedAt ?? ''),
    sentAt: item.sentAt ? String(item.sentAt) : null,
    seen: Boolean(keywords.$seen), flagged: Boolean(keywords.$flagged), answered: Boolean(keywords.$answered),
    draft: Boolean(keywords.$draft),
    preview: String(item.preview ?? '').trim(),
    hasAttachment: Boolean(item.hasAttachment),
  }
}

export type JmapOptions = { token: string; sessionUrl?: string; fetch?: typeof fetch; signal?: AbortSignal }

export class Jmap {
  private sessionPromise: Promise<Session> | undefined
  private mailboxCache: { at: number; list: Mailbox[] } | undefined
  readonly token: string
  readonly sessionUrl: string
  private readonly fetcher: typeof fetch
  private readonly signal: AbortSignal | undefined

  constructor({ token, sessionUrl = FASTMAIL_SESSION, fetch: fetcher = fetch, signal }: JmapOptions) {
    this.token = token.trim()
    this.sessionUrl = sessionUrl
    this.fetcher = fetcher
    this.signal = signal
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...extra }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(url, { ...init, signal: init.signal ?? this.signal, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) throw new JmapError('Fastmail refused the API token (401). Check it in Settings → Email.', 'unauthorized')
      throw new JmapError(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    return response
  }

  session(): Promise<Session> {
    if (!this.token) return Promise.reject(new JmapError('No Fastmail API token: set one in Settings → Email.', 'no-token'))
    this.sessionPromise ??= (async () => {
      const response = await this.request(this.sessionUrl)
      const session = await response.json() as Session
      if (!session.apiUrl || !session.primaryAccounts?.[MAIL]) throw new JmapError('The JMAP session has no mail account.')
      return session
    })().catch((error) => { this.sessionPromise = undefined; throw error })
    return this.sessionPromise
  }

  async accountId(capability = MAIL): Promise<string> {
    const session = await this.session()
    const id = session.primaryAccounts[capability]
    if (!id) throw new JmapError(`This account has no ${capability.split(':').pop()} capability.`, 'unsupported')
    return id
  }

  async has(capability: string) { return Boolean((await this.session()).capabilities[capability]) }

  /** Run method calls in one request; answers each by its tag. A method error throws, saying which. */
  async call(calls: Call[], using: string[] = [MAIL]): Promise<Record<string, Raw>> {
    const session = await this.session()
    const response = await this.request(session.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: [CORE, ...using], methodCalls: calls }),
    })
    const payload = await response.json() as { methodResponses?: [string, Raw, string][] }
    const out: Record<string, Raw> = {}
    for (const [name, args, tag] of payload.methodResponses ?? []) {
      if (name === 'error') throw new JmapError(`${calls.find((c) => c[2] === tag)?.[0] ?? 'JMAP'}: ${args.description ?? args.type}`, String(args.type))
      out[tag] = args
    }
    return out
  }

  // Mailboxes

  async mailboxes({ fresh = false } = {}): Promise<Mailbox[]> {
    if (!fresh && this.mailboxCache && Date.now() - this.mailboxCache.at < 2000) return this.mailboxCache.list
    const accountId = await this.accountId()
    const { mb } = await this.call([['Mailbox/get', { accountId, ids: null, properties: ['id', 'name', 'role', 'parentId', 'sortOrder', 'totalEmails', 'unreadEmails'] }, 'mb']])
    const order = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']
    const rank = (role: string | null) => { const i = role ? order.indexOf(role) : -1; return i < 0 ? order.length : i }
    const list: Mailbox[] = (mb!.list as Raw[]).map((m) => ({
      id: String(m.id), name: String(m.name ?? '').trim(), role: m.role ? String(m.role).toLowerCase() : null,
      parentId: m.parentId ? String(m.parentId) : null, sortOrder: Number(m.sortOrder ?? 0),
      total: Math.max(0, Number(m.totalEmails ?? 0)), unread: Math.max(0, Number(m.unreadEmails ?? 0)),
    }))
    list.sort((a, b) => rank(a.role) - rank(b.role) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    this.mailboxCache = { at: Date.now(), list }
    return list
  }

  async role(role: string): Promise<Mailbox> {
    const mailbox = roleMailbox(await this.mailboxes(), role)
    if (!mailbox) throw new JmapError(`No ${role} mailbox.`)
    return mailbox
  }

  // Reading

  /** Message summaries matching a JMAP filter, newest first. */
  async query(filter: Raw | null, { limit = 200, position = 0 } = {}): Promise<{ messages: Summary[]; total: number }> {
    const accountId = await this.accountId()
    const r = await this.call([
      ['Email/query', { accountId, ...(filter ? { filter } : {}), sort: [{ property: 'receivedAt', isAscending: false }], limit, position, calculateTotal: true }, 'q'],
      ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY_PROPERTIES }, 'g'],
    ])
    const order = new Map((r.q!.ids as string[]).map((id, i) => [id, i]))
    const messages = (r.g!.list as Raw[]).map(toSummary).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return { messages, total: Number(r.q!.total ?? messages.length) }
  }

  /** A mailbox's threads, newest first; ignored (flagged) ones left out unless asked for. */
  async list(mailboxId: string, { limit = 500, search, showIgnored = false }: { limit?: number; search?: string; showIgnored?: boolean } = {}): Promise<ListResult> {
    const filter: Raw = search?.trim() ? { operator: 'AND', conditions: [{ inMailbox: mailboxId }, ...searchConditions(search)] } : { inMailbox: mailboxId }
    const { messages, total } = await this.query(filter, { limit })
    const { threads, ignored } = groupThreads(messages, { ignoreFlagged: !showIgnored })
    return { mailboxId, threads, total, loaded: messages.length, ignored }
  }

  async summaries(ids: string[]): Promise<Summary[]> {
    if (!ids.length) return []
    const accountId = await this.accountId()
    const { g } = await this.call([['Email/get', { accountId, ids, properties: SUMMARY_PROPERTIES }, 'g']])
    return (g!.list as Raw[]).map(toSummary)
  }

  /** One message whole: its bodies with inline images resolved, its attachments, and its conversation. */
  async detail(id: string): Promise<Detail> {
    const accountId = await this.accountId()
    const r = await this.call([
      ['Email/get', {
        accountId, ids: [id], fetchTextBodyValues: true, fetchHTMLBodyValues: true, fetchAllBodyValues: true,
        properties: [...SUMMARY_PROPERTIES, 'attachments', 'bodyStructure', 'bodyValues', 'textBody', 'htmlBody'],
      }, 'd'],
      ['Thread/get', { accountId, '#ids': { resultOf: 'd', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: SUMMARY_PROPERTIES }, 'tm'],
    ])
    const item = (r.d!.list as Raw[])[0]
    if (!item) throw new JmapError(`No message ${id}.`, 'notFound')
    const values = (item.bodyValues ?? {}) as Record<string, { value?: string }>
    const join = (parts: Raw[] | undefined) => (parts ?? []).map((p) => values[p.partId]?.value).filter((v): v is string => v !== undefined).join('\n').trim()
    const htmlParts = (item.htmlBody ?? []) as Raw[]
    const isHtmlPart = (p: Raw) => String(p.type ?? '').toLowerCase().startsWith('text/html')
    const hasHtmlPart = htmlParts.some(isHtmlPart)
    let text = join(item.textBody)
    let html = hasHtmlPart ? join(htmlParts.filter(isHtmlPart)) : ''
    if (!html && !htmlParts.some((p) => String(p.type ?? '').toLowerCase().startsWith('image/'))) html = inferHTML(values)
    if (!text) text = String(item.preview ?? '').trim()

    const raw = (item.attachments ?? []) as Raw[]
    const images: Record<string, string> = {}
    const image = async (blobId: string, type: string, name: string) => {
      if (images[blobId] === undefined) {
        const data = await this.download(blobId, name || 'inline', type).catch(() => undefined)
        images[blobId] = data?.length ? `data:${type || 'application/octet-stream'};base64,${data.toString('base64')}` : ''
      }
      return images[blobId]
    }

    // A message of text and image parts with no HTML (a phone's photo between lines): show them in order.
    if (htmlParts.length && !hasHtmlPart && htmlParts.some((p) => String(p.type ?? '').toLowerCase().startsWith('image/'))) {
      const fragments: string[] = []
      for (const part of htmlParts) {
        const type = String(part.type ?? '').toLowerCase()
        const value = values[part.partId]?.value
        if (type.startsWith('text/plain') && value) fragments.push(`<article class="snailblaze-plain-text">${escapeHTML(value)}</article>`)
        else if (type.startsWith('image/') && part.blobId) {
          const src = await image(String(part.blobId), type, String(part.name ?? ''))
          if (src) fragments.push(`<figure><img src="${src}" alt="${escapeHTML(String(part.name ?? '').trim() || 'inline image')}"></figure>`)
        }
      }
      html = fragments.join('\n')
    }

    // `cid:` images, found among the attachments and anywhere in the structure.
    const used = new Set<string>()
    if (html && /\bsrc\s*=\s*["']cid:/i.test(html)) {
      const byCid = new Map<string, Raw>()
      for (const part of [...raw, ...inlineParts(item.bodyStructure)]) {
        if (!part.blobId) continue
        for (const key of cidKeys(part.cid)) if (!byCid.has(key)) byCid.set(key, part)
      }
      const sources = new Map<string, string>()
      for (const match of html.matchAll(/\bsrc\s*=\s*(["'])cid:([^"'>]+)\1/gi)) {
        const cid = normalizeCid(match[2])
        if (!cid || sources.has(cid)) continue
        const part = cidKeys(cid).map((key) => byCid.get(key)).find(Boolean)
        if (!part) continue
        const src = await image(String(part.blobId), String(part.type ?? ''), String(part.name ?? ''))
        if (src) { sources.set(cid, src); used.add(String(part.blobId)) }
      }
      html = html.replace(/(\bsrc\s*=\s*['"])cid:([^"'>]+)(['"])/gi, (whole, pre: string, cid: string, post: string) => {
        const src = sources.get(normalizeCid(cid))
        return src ? `${pre}${src}${post}` : whole
      })
    }

    const attachments: Attachment[] = raw
      .filter((a) => a.blobId && !used.has(String(a.blobId)))
      .map((a) => ({ blobId: String(a.blobId), name: cleanName(a.name), type: String(a.type ?? 'application/octet-stream'), size: Number(a.size ?? 0), partId: a.partId ? String(a.partId) : null }))
    const thread = ((r.tm?.list ?? []) as Raw[]).map(toSummary).sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0))
    return { summary: toSummary(item), html, text, attachments, thread: thread.length ? thread : [toSummary(item)] }
  }

  async download(blobId: string, name: string, type: string): Promise<Buffer> {
    const session = await this.session()
    const url = session.downloadUrl
      .replace('{accountId}', encodeURIComponent(await this.accountId()))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(name || 'download'))
    const response = await this.request(url, { headers: { Accept: type || '*/*' } })
    return Buffer.from(await response.arrayBuffer())
  }

  async upload(data: Buffer, type: string): Promise<{ blobId: string; type: string; size: number }> {
    const session = await this.session()
    const url = session.uploadUrl.replace('{accountId}', encodeURIComponent(await this.accountId()))
    const response = await this.request(url, { method: 'POST', headers: { 'Content-Type': type || 'application/octet-stream' }, body: new Uint8Array(data) })
    const json = await response.json() as Raw
    return { blobId: String(json.blobId), type: String(json.type ?? type), size: Number(json.size ?? data.length) }
  }

  // Changing

  /** Patch emails; answers the ids that took it. Fails when none did. */
  async patch(updates: Record<string, Raw>): Promise<string[]> {
    const ids = Object.keys(updates)
    if (!ids.length) return []
    const accountId = await this.accountId()
    const { s } = await this.call([['Email/set', { accountId, update: updates }, 's']])
    const updated = Object.keys((s!.updated ?? {}) as Raw)
    const failed = Object.entries((s!.notUpdated ?? {}) as Record<string, Raw>)
    if (!updated.length && failed.length) throw new JmapError(`Couldn't change the message: ${failed[0]![1].description ?? failed[0]![1].type}`)
    this.mailboxCache = undefined
    return updated
  }

  async keywords(ids: string[], set: string[], clear: string[]) {
    const patch: Raw = {}
    for (const k of set) patch[`keywords/${k}`] = true
    for (const k of clear) patch[`keywords/${k}`] = null
    return this.patch(Object.fromEntries(ids.map((id) => [id, patch])))
  }

  /** Move messages out of `source` into `destination` (a label change in Fastmail: other mailboxes stay). */
  async move(entries: Entry[], source: string, destination: string, { junk = false } = {}) {
    if (source === destination) throw new JmapError('It is already there.')
    const patch: Raw = { [`mailboxIds/${pointer(source)}`]: null, [`mailboxIds/${pointer(destination)}`]: true }
    if (junk) { patch['keywords/$junk'] = true; patch['keywords/$notjunk'] = null }
    return this.patch(Object.fromEntries(entries.map((e) => [e.id, patch])))
  }

  /** Put moved messages back as they were in both mailboxes. */
  async restore(entries: Entry[], source: string, destination: string, { junk = false } = {}) {
    return this.patch(Object.fromEntries(entries.map((e) => {
      const patch: Raw = {
        [`mailboxIds/${pointer(source)}`]: e.mailboxIds.includes(source) ? true : null,
        [`mailboxIds/${pointer(destination)}`]: e.mailboxIds.includes(destination) ? true : null,
      }
      if (junk) { patch['keywords/$junk'] = null; patch['keywords/$notjunk'] = true }
      return [e.id, patch]
    })))
  }

  async destroy(ids: string[]) {
    if (!ids.length) return
    const accountId = await this.accountId()
    const { x } = await this.call([['Email/set', { accountId, destroy: ids }, 'x']])
    const failed = Object.entries((x!.notDestroyed ?? {}) as Record<string, Raw>).filter(([, e]) => e.type !== 'notFound')
    if (failed.length) throw new JmapError(`Couldn't delete: ${failed[0]![1].description ?? failed[0]![1].type}`)
  }

  /** Move a blocked sender's mail in `mailboxId` to Junk; answers how many. */
  async sweepBlocked(messages: Summary[], mailboxId: string, blocked: string[]): Promise<{ moved: string[]; matched: number }> {
    if (!blocked.length) return { moved: [], matched: 0 }
    const hits = messages.filter((m) => matchSender(m.from, blocked))
    if (!hits.length) return { moved: [], matched: 0 }
    const junk = await this.role('junk')
    if (junk.id === mailboxId) return { moved: [], matched: 0 }
    const moved = await this.move(hits.map((m) => ({ id: m.id, mailboxIds: m.mailboxIds, flagged: m.flagged, seen: m.seen })), mailboxId, junk.id, { junk: true })
    return { moved, matched: hits.length }
  }

  // Drafts and sending

  async identities(): Promise<{ id: string; email: string; name: string; isDefault?: boolean }[]> {
    const accountId = await this.accountId(SUBMISSION).catch(() => this.accountId())
    const { i } = await this.call([['Identity/get', { accountId, ids: null }, 'i']], [MAIL, SUBMISSION])
    return (i!.list as Raw[]).map((x) => ({ id: String(x.id), email: String(x.email ?? ''), name: String(x.name ?? ''), isDefault: x.isDefault }))
  }

  /** The identity to send as: the one with `email`, else Fastmail's default (or the first). */
  async identity(email?: string) {
    const list = await this.identities()
    const want = email?.trim().toLowerCase()
    if (want) {
      const match = list.find((x) => x.email.trim().toLowerCase() === want)
      if (match) return match
      throw new JmapError(`No sending identity for ${want}.`)
    }
    const identity = list.find((x) => x.isDefault) ?? list[0]
    if (!identity) throw new JmapError('No sending identity.')
    return identity
  }

  /**
   * Save a draft to Drafts as a new email, replacing the copy it says it replaces (JMAP emails can't be edited). A reply
   * threads onto its original (In-Reply-To, References). Answers the new copy's id.
   */
  async saveDraft(draft: DraftInput, { senderEmail }: { senderEmail?: string } = {}): Promise<string> {
    const accountId = await this.accountId()
    const drafts = await this.role('drafts')
    const identity = await this.identity(senderEmail || undefined)
    const to = parseList(draft.to, 'To'), cc = parseList(draft.cc, 'Cc'), bcc = parseList(draft.bcc, 'Bcc')
    const create: Raw = {
      mailboxIds: { [drafts.id]: true },
      keywords: { $draft: true, $seen: true },
      from: [identity.name ? { name: identity.name, email: identity.email } : { email: identity.email }],
      to, subject: draft.subject.trim(),
      messageId: [`${randomUUID()}@${identity.email.split('@').pop() || 'superego'}`],
    }
    if (cc.length) create.cc = cc
    if (bcc.length) create.bcc = bcc
    Object.assign(create, bodyFields(draft.body, draft.markdown ? renderMarkdown(draft.body) : null, draft.attachments))
    if (draft.markdown) create['header:X-Superego-Markdown'] = ' yes'
    if (draft.inReplyTo) {
      const { o } = await this.call([['Email/get', { accountId, ids: [draft.inReplyTo], properties: ['id', 'messageId', 'references'] }, 'o']])
      const original = (o!.list as Raw[])[0]
      const messageId = original?.messageId?.[0]
      if (messageId) {
        create.inReplyTo = [messageId]
        create.references = [...(original.references ?? []), messageId]
      }
    }
    const { s } = await this.call([['Email/set', { accountId, create: { draft: create }, ...(draft.replaces ? { destroy: [draft.replaces] } : {}) }, 's']])
    const id = (s!.created as Raw | undefined)?.draft?.id
    if (!id) {
      const why = (s!.notCreated as Raw | undefined)?.draft
      throw new JmapError(`Couldn't save the draft: ${why?.description ?? why?.type ?? 'unknown error'}`)
    }
    this.mailboxCache = undefined
    return String(id)
  }

  /** A draft read back for the composer. */
  async loadDraft(id: string): Promise<LoadedDraft> {
    const accountId = await this.accountId()
    const { d } = await this.call([['Email/get', {
      accountId, ids: [id], fetchTextBodyValues: true,
      properties: ['id', 'to', 'cc', 'bcc', 'subject', 'textBody', 'bodyValues', 'attachments', 'inReplyTo', 'header:X-Superego-Markdown', 'htmlBody'],
    }, 'd']])
    const item = (d!.list as Raw[])[0]
    if (!item) throw new JmapError(`No draft ${id}.`, 'notFound')
    const values = (item.bodyValues ?? {}) as Record<string, { value?: string }>
    const body = ((item.textBody ?? []) as Raw[]).map((p) => values[p.partId]?.value ?? '').join('\n')
    let inReplyTo: string | null = null
    const header = (item.inReplyTo as string[] | null)?.[0]
    if (header) {
      const { q } = await this.call([['Email/query', { accountId, filter: { header: ['Message-ID', `<${header}>`] }, limit: 1 }, 'q']]).catch(() => ({ q: { ids: [] } as Raw }))
      inReplyTo = (q?.ids as string[] | undefined)?.[0] ?? null
    }
    const fmt = (list: unknown) => addrs(list).map((a) => a.name && a.name !== a.email ? `${/[,;<>@]/.test(a.name) ? `"${a.name}"` : a.name} <${a.email}>` : a.email).join(', ')
    return {
      id: String(item.id), to: fmt(item.to), cc: fmt(item.cc), bcc: fmt(item.bcc), subject: String(item.subject ?? ''), body,
      markdown: Boolean(item['header:X-Superego-Markdown']?.trim()) || Boolean((item.htmlBody as Raw[] | undefined)?.some((p) => String(p.type).startsWith('text/html'))),
      attachments: ((item.attachments ?? []) as Raw[]).map((a) => ({ blobId: String(a.blobId), name: cleanName(a.name), type: String(a.type ?? 'application/octet-stream'), size: Number(a.size ?? 0), partId: a.partId ? String(a.partId) : null })),
      inReplyTo, replaces: String(item.id),
    }
  }

  /**
   * Send a draft in Drafts: Fastmail delivers it, and moves it to Sent and clears `$draft` once it has. The original of a
   * reply gets `$answered`. Throws, saying whether it may have gone, when it can't tell.
   */
  async send(draftId: string, { senderEmail }: { senderEmail?: string } = {}): Promise<void> {
    const accountId = await this.accountId()
    if (!await this.has(SUBMISSION)) throw new JmapError('This token may not send mail: give it the Submission scope.')
    const drafts = await this.role('drafts')
    const sent = roleMailbox(await this.mailboxes(), 'sent')
    const { d } = await this.call([['Email/get', { accountId, ids: [draftId], properties: ['id', 'from', 'inReplyTo', 'to', 'cc', 'bcc'] }, 'd']])
    const draft = (d!.list as Raw[])[0]
    if (!draft) throw new JmapError('That draft is gone from Drafts.', 'notFound')
    if (!addrs(draft.to).length && !addrs(draft.cc).length && !addrs(draft.bcc).length) throw new JmapError('The draft has no recipients.')
    const identity = await this.identity(addrs(draft.from)[0]?.email || senderEmail || undefined)
    const args: Raw = { accountId, create: { send: { emailId: draftId, identityId: identity.id } } }
    if (sent) args.onSuccessUpdateEmail = { '#send': { [`mailboxIds/${pointer(drafts.id)}`]: null, [`mailboxIds/${pointer(sent.id)}`]: true, 'keywords/$draft': null } }
    let r: Record<string, Raw>
    try {
      r = await this.call([['EmailSubmission/set', args, 'send']], [MAIL, SUBMISSION])
    } catch (error) {
      if (error instanceof JmapError && error.type) throw error
      throw new JmapError(`It may or may not have been sent (${(error as Error).message}). Look in Sent before sending it again.`, 'uncertain')
    }
    const notCreated = (r.send?.notCreated as Raw | undefined)?.send
    if (notCreated) throw new JmapError(`Fastmail didn't send it: ${notCreated.description ?? notCreated.type}`)
    this.mailboxCache = undefined
    const header = (draft.inReplyTo as string[] | null)?.[0]
    if (header) {
      const { q } = await this.call([['Email/query', { accountId, filter: { header: ['Message-ID', `<${header}>`] }, limit: 5 }, 'q']]).catch(() => ({ q: undefined }))
      const ids = (q?.ids as string[] | undefined) ?? []
      if (ids.length) await this.keywords(ids, ['$answered'], []).catch(() => {})
    }
  }

  // Contacts: the Newsletters workflow adds a sender to a contact group (Fastmail's rules can file by group).

  async addToGroup(sender: Addr, groupName: string): Promise<'added' | 'already' | 'unsupported'> {
    if (!await this.has(CONTACTS)) return 'unsupported'
    const accountId = await this.accountId(CONTACTS).catch(() => '')
    if (!accountId) return 'unsupported'
    const email = sender.email.trim().toLowerCase()
    const call = (calls: Call[]) => this.call(calls, [CONTACTS])
    const cards = async (ids: string[]) => ids.length
      ? ((await call([['ContactCard/get', { accountId, ids, properties: ['id', 'uid', 'kind', 'name', 'members'] }, 'c']])).c!.list as Raw[])
      : []
    const books = (await call([['AddressBook/get', { accountId, ids: null, properties: ['id', 'name', 'isDefault'] }, 'b']])).b!.list as Raw[]
    const book = books.find((b) => b.isDefault) ?? books[0]
    if (!book) throw new JmapError('No address book.')
    const name = (value: string) => ({ components: [{ kind: 'given', value }], isOrdered: true })
    const create = async (card: Raw) => {
      const { s } = await call([['ContactCard/set', { accountId, create: { card: { '@type': 'Card', version: '1.0', uid: randomUUID(), addressBookIds: { [book.id]: true }, ...card } } }, 's']])
      const id = (s!.created as Raw | undefined)?.card?.id
      if (!id) throw new JmapError(`Couldn't create the contact: ${JSON.stringify((s!.notCreated as Raw | undefined)?.card ?? {})}`)
      return (await cards([String(id)]))[0]!
    }
    const found = (await call([['ContactCard/query', { accountId, filter: { email }, limit: 10 }, 'q']])).q!.ids as string[]
    const contact = (await cards(found))[0] ?? await create({ name: name(sender.name.trim() || email), emails: { main: { address: email } } })
    const groupIds = (await call([['ContactCard/query', { accountId, filter: { kind: 'group' }, limit: 200 }, 'q']])).q!.ids as string[]
    const display = (card: Raw) => ((card.name?.components ?? []) as Raw[]).map((c) => c.value).join(' ').trim()
    const group = (await cards(groupIds)).find((g) => display(g).toLowerCase() === groupName.trim().toLowerCase())
      ?? await create({ kind: 'group', name: name(groupName.trim()), members: {} })
    const members = { ...(group.members ?? {}) } as Record<string, boolean>
    if (members[contact.uid]) return 'already'
    members[contact.uid] = true
    const { s } = await call([['ContactCard/set', { accountId, update: { [group.id]: { members } } }, 's']])
    if (Object.keys((s!.notUpdated ?? {}) as Raw).length) throw new JmapError('Couldn\'t add the sender to the group.')
    return 'added'
  }

  // Push

  /** The session's event source (Fastmail's push), for `listen`. */
  async eventSourceUrl() { return (await this.session()).eventSourceUrl }

  /**
   * Hear the server's state changes over its event source until `signal` aborts, calling `onChange` for each. Resolves
   * when the stream ends (the caller reconnects).
   */
  async listen(onChange: () => void, signal: AbortSignal): Promise<void> {
    const base = await this.eventSourceUrl()
    if (!base) throw new JmapError('No event source.')
    const url = base.replace('{types}', '*').replace('{closeafter}', 'no').replace('{ping}', '120')
    const response = await this.request(url, { headers: { Accept: 'text/event-stream' }, signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let first = true
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:') && (event === 'state' || event === '')) {
          // The first state says how things are as we connect: nothing changed yet.
          if (first) first = false
          else onChange()
        } else if (!line) event = ''
      }
    }
  }
}

function parseList(text: string, field: string): { name?: string; email: string }[] {
  const { addrs: list, invalid } = parseAddrs(text)
  if (invalid.length) throw new JmapError(`${field}: "${invalid[0]}" isn't an email address.`)
  return list.map((a) => a.name ? { name: a.name, email: a.email } : { email: a.email })
}

/** The body parts of a message to create: text, HTML too when Markdown made one, attachments after them. */
export function bodyFields(text: string, html: string | null, attachments: Attachment[]): Raw {
  const bodyValues: Raw = { text: { value: text } }
  if (html) bodyValues.html = { value: html }
  if (!attachments.length) {
    return { bodyValues, textBody: [{ partId: 'text', type: 'text/plain' }], ...(html ? { htmlBody: [{ partId: 'html', type: 'text/html' }] } : {}) }
  }
  const content = html
    ? { type: 'multipart/alternative', subParts: [{ partId: 'text', type: 'text/plain' }, { partId: 'html', type: 'text/html' }] }
    : { partId: 'text', type: 'text/plain' }
  return {
    bodyValues,
    bodyStructure: {
      type: 'multipart/mixed',
      subParts: [content, ...attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' }))],
    },
  }
}

const cleanName = (name: unknown) => String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim() || '(unnamed)'

export function normalizeCid(raw: unknown): string {
  let value = String(raw ?? '').trim()
  try { value = decodeURIComponent(value) } catch { /* as it is */ }
  value = value.replace(/^cid:/i, '').trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1)
  return value.trim().toLowerCase()
}
function cidKeys(raw: unknown): string[] {
  const cid = normalizeCid(raw)
  if (!cid) return []
  const at = cid.indexOf('@')
  return at > 0 ? [cid, cid.slice(0, at)] : [cid]
}
function inlineParts(part: Raw | undefined): Raw[] {
  const out: Raw[] = []
  const walk = (p: Raw) => {
    const type = String(p.type ?? '').toLowerCase()
    if (p.blobId && (normalizeCid(p.cid) || String(p.disposition ?? '').toLowerCase() === 'inline' || type.startsWith('image/'))) out.push(p)
    for (const child of (p.subParts ?? []) as Raw[]) walk(child)
  }
  if (part) walk(part)
  return out
}

const HTMLISH = /<\s*(html|head|body|div|p|table|tr|td|th|img|span|a|br|h[1-6]|ul|ol|li|blockquote|section|article|font|strong|em|b|i)\b|<\s*\/\s*(div|p|table|tr|td|th|span|a|h[1-6]|ul|ol|li|blockquote|section|article|font|strong|em|b|i)\s*>/i
/** The longest body value that looks like HTML, for a message whose structure doesn't say it has HTML. */
function inferHTML(values: Record<string, { value?: string }>): string {
  let best = ''
  for (const key of Object.keys(values).sort()) {
    const candidate = (values[key]?.value ?? '').trim()
    if (candidate && HTMLISH.test(candidate) && candidate.length > best.length) best = candidate
  }
  return best
}

export const escapeHTML = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
