// A small JMAP server for tests: enough of Fastmail (session, mailboxes, email query/get/set, threads, identities,
// submission, contacts, blobs, the event source) over real HTTP on localhost, with a fixture mailbox. Not a test itself.
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Raw = Record<string, any>

export type FakeEmail = {
  id: string
  threadId: string
  mailboxIds: Record<string, boolean>
  keywords: Record<string, boolean>
  subject: string
  from: { name?: string; email: string }[]
  to: { name?: string; email: string }[]
  cc?: { name?: string; email: string }[]
  replyTo?: { name?: string; email: string }[]
  receivedAt: string
  messageId?: string[]
  references?: string[]
  inReplyTo?: string[]
  text?: string
  html?: string
  attachments?: { blobId: string; name: string; type: string; size: number; cid?: string; disposition?: string; partId?: string }[]
  extraHeaders?: Record<string, string>
}

export const TOKEN = 'fmu1-test-token'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export function fixture() {
  const mailboxes = [
    { id: 'mb-inbox', name: 'INBOX', role: 'inbox', parentId: null, sortOrder: 1 },
    { id: 'mb-archive', name: 'Archive', role: 'archive', parentId: null, sortOrder: 2 },
    { id: 'mb-drafts', name: 'Drafts', role: 'drafts', parentId: null, sortOrder: 3 },
    { id: 'mb-sent', name: 'Sent', role: 'sent', parentId: null, sortOrder: 4 },
    { id: 'mb-junk', name: 'Spam', role: 'junk', parentId: null, sortOrder: 5 },
    { id: 'mb-trash', name: 'Trash', role: 'trash', parentId: null, sortOrder: 6 },
    { id: 'mb-news', name: 'Newsletters', role: null, parentId: null, sortOrder: 7 },
    { id: 'mb-work', name: 'Work', role: null, parentId: null, sortOrder: 8 },
  ]
  const inbox = { 'mb-inbox': true }
  const emails: FakeEmail[] = [
    {
      id: 'm1', threadId: 't1', mailboxIds: inbox, keywords: { $seen: true }, subject: 'Lunch on Friday?',
      from: [{ name: 'Ada Lovelace', email: 'ada@example.com' }], to: [{ name: 'Mikkel', email: 'me@example.com' }],
      receivedAt: '2026-11-20T09:00:00Z', messageId: ['m1@example.com'],
      text: 'Hi!\n\nLunch on Friday at https://example.com/place?\n\n> earlier\n> > much earlier\n\nAda',
    },
    {
      id: 'm2', threadId: 't1', mailboxIds: { 'mb-inbox': true, 'mb-work': true }, keywords: {}, subject: 'Re: Lunch on Friday?',
      from: [{ name: 'Ada Lovelace', email: 'ada@example.com' }], to: [{ name: 'Mikkel', email: 'me@example.com' }],
      cc: [{ name: 'Grace', email: 'grace@example.com' }],
      receivedAt: '2026-11-21T10:00:00Z', messageId: ['m2@example.com'], references: ['m1@example.com'],
      text: 'Make it noon.\n\nAda',
    },
    {
      id: 'm3', threadId: 't3', mailboxIds: inbox, keywords: {}, subject: 'The Weekly Digest',
      from: [{ name: 'Digest', email: 'news@letters.example.org' }], to: [{ email: 'me@example.com' }],
      receivedAt: '2026-11-21T12:00:00Z', messageId: ['m3@letters.example.org'],
      text: 'This week in things.',
      html: '<html><head><style>.hero{color:#123}</style></head><body bgcolor="#f4f4f4"><table width="600" style="background:#ffffff"><tr><td class="hero"><h1>This week</h1><img src="cid:logo@letters" alt="logo"><img src="https://tracker.example.org/pixel.gif" width="1" height="1"><a href="https://letters.example.org/read">Read more</a></td></tr></table><script>alert(1)</script></body></html>',
      attachments: [
        { blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: PNG.length, cid: '<logo@letters>', disposition: 'inline', partId: '3' },
        { blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 9, partId: '4' },
      ],
    },
    {
      id: 'm4', threadId: 't4', mailboxIds: inbox, keywords: { $flagged: true }, subject: 'Ignored thing',
      from: [{ email: 'later@example.com' }], to: [{ email: 'me@example.com' }], receivedAt: '2026-11-19T08:00:00Z', text: 'Later.',
    },
    {
      id: 'm5', threadId: 't5', mailboxIds: inbox, keywords: {}, subject: 'You won a prize',
      from: [{ email: 'promo@spam.example.net' }], to: [{ email: 'me@example.com' }], receivedAt: '2026-11-18T08:00:00Z', text: 'Click here.',
    },
  ]
  const blobs: Record<string, { type: string; data: Buffer }> = {
    'blob-logo': { type: 'image/png', data: PNG },
    'blob-pdf': { type: 'application/pdf', data: Buffer.from('%PDF-1.4\n') },
  }
  for (const e of emails) { e.mailboxIds = { ...e.mailboxIds }; e.keywords = { ...e.keywords } }
  return { mailboxes, emails, blobs }
}

export type FakeJmap = Awaited<ReturnType<typeof startFakeJmap>>

export async function startFakeJmap(data = fixture()) {
  const { mailboxes, emails, blobs } = data
  const sent: { emailId: string; identityId: string }[] = []
  const contacts: Raw[] = []
  const streams = new Set<ServerResponse>()
  let state = 1
  let next = 1
  const id = (prefix: string) => `${prefix}-${next++}`
  const bump = () => {
    state++
    for (const res of streams) res.write(`event: state\ndata: {"changed":{"acc":{"Email":"${state}"}}}\n\n`)
  }

  const summaryOf = (e: FakeEmail, properties?: string[]): Raw => {
    const textPart = { partId: '1', type: 'text/plain', blobId: `${e.id}-text` }
    const htmlPart = { partId: '2', type: 'text/html', blobId: `${e.id}-html` }
    const all: Raw = {
      id: e.id, threadId: e.threadId, mailboxIds: e.mailboxIds, keywords: e.keywords, subject: e.subject,
      from: e.from, to: e.to, cc: e.cc ?? null, bcc: null, replyTo: e.replyTo ?? null, receivedAt: e.receivedAt, sentAt: e.receivedAt,
      preview: (e.text ?? '').slice(0, 80), hasAttachment: Boolean(e.attachments?.some((a) => a.disposition !== 'inline')),
      messageId: e.messageId ?? [`${e.id}@fake`], references: e.references ?? null, inReplyTo: e.inReplyTo ?? null,
      textBody: e.text !== undefined ? [textPart] : [],
      htmlBody: e.html !== undefined ? [htmlPart] : e.text !== undefined ? [textPart] : [],
      bodyValues: { ...(e.text !== undefined ? { 1: { value: e.text } } : {}), ...(e.html !== undefined ? { 2: { value: e.html } } : {}) },
      attachments: e.attachments ?? [],
      bodyStructure: { type: 'multipart/mixed', subParts: [textPart, ...(e.html ? [htmlPart] : []), ...(e.attachments ?? [])] },
    }
    for (const [name, value] of Object.entries(e.extraHeaders ?? {})) all[`header:${name}`] = value
    if (!properties) return all
    return Object.fromEntries(properties.map((p) => [p, all[p] ?? null]))
  }

  const matches = (e: FakeEmail, filter: Raw | undefined): boolean => {
    if (!filter) return true
    if (filter.operator === 'AND') return (filter.conditions as Raw[]).every((c) => matches(e, c))
    if (filter.operator === 'OR') return (filter.conditions as Raw[]).some((c) => matches(e, c))
    if (filter.inMailbox && !e.mailboxIds[filter.inMailbox]) return false
    if (filter.hasKeyword && !e.keywords[filter.hasKeyword]) return false
    if (filter.notKeyword && e.keywords[filter.notKeyword]) return false
    if (filter.from && !e.from.some((a) => `${a.name ?? ''} ${a.email}`.toLowerCase().includes(String(filter.from).toLowerCase()))) return false
    if (filter.subject && !e.subject.toLowerCase().includes(String(filter.subject).toLowerCase())) return false
    if (filter.text && !`${e.subject} ${e.text ?? ''} ${e.from.map((a) => a.email).join(' ')}`.toLowerCase().includes(String(filter.text).toLowerCase())) return false
    if (filter.header) {
      const [name, value] = filter.header as string[]
      if (name!.toLowerCase() === 'message-id' && !(e.messageId ?? []).some((m) => `<${m}>` === value)) return false
    }
    return true
  }

  const pointer = (value: unknown, path: string): unknown => {
    let current: unknown[] = [value]
    let spread = false
    for (const part of path.split('/').slice(1)) {
      if (part === '*') { current = current.flatMap((v) => Array.isArray(v) ? v : []); spread = true; continue }
      current = current.map((v) => (v as Raw)?.[part]).filter((v) => v !== undefined)
    }
    return spread ? current.flatMap((v) => Array.isArray(v) ? v : [v]) : current[0]
  }

  const apply = (target: Raw, patch: Raw) => {
    for (const [path, value] of Object.entries(patch)) {
      const [head, ...rest] = path.split('/')
      if (!rest.length) { target[head!] = value; continue }
      const key = rest.join('/').replace(/~1/g, '/').replace(/~0/g, '~')
      target[head!] ??= {}
      if (value === null) delete target[head!][key]
      else target[head!][key] = value
    }
  }

  const methods: Record<string, (args: Raw) => Raw> = {
    'Mailbox/get': () => ({
      list: mailboxes.map((m) => ({
        ...m,
        totalEmails: emails.filter((e) => e.mailboxIds[m.id]).length,
        unreadEmails: emails.filter((e) => e.mailboxIds[m.id] && !e.keywords.$seen).length,
      })),
    }),
    'Email/query': (args) => {
      const found = emails.filter((e) => matches(e, args.filter)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      const position = args.position ?? 0
      return { ids: found.slice(position, position + (args.limit ?? 1000)).map((e) => e.id), total: found.length, position, queryState: String(state) }
    },
    'Email/get': (args) => {
      const ids = (args.ids ?? emails.map((e) => e.id)) as string[]
      const list = ids.map((x) => emails.find((e) => e.id === x)).filter((e): e is FakeEmail => Boolean(e))
      return { list: list.map((e) => summaryOf(e, args.properties)), notFound: ids.filter((x) => !emails.some((e) => e.id === x)) }
    },
    'Thread/get': (args) => ({
      list: (args.ids as string[]).map((t) => ({ id: t, emailIds: emails.filter((e) => e.threadId === t).map((e) => e.id) })),
    }),
    'Email/set': (args) => {
      const out: Raw = { updated: {}, notUpdated: {}, created: {}, destroyed: [], notDestroyed: {} }
      for (const [x, patch] of Object.entries((args.update ?? {}) as Raw)) {
        const e = emails.find((m) => m.id === x)
        if (!e) { out.notUpdated[x] = { type: 'notFound' }; continue }
        apply(e as unknown as Raw, patch)
        out.updated[x] = null
      }
      for (const [key, create] of Object.entries((args.create ?? {}) as Raw)) {
        const newId = id('draft')
        const html = create.bodyValues?.html?.value
        const text = create.bodyValues?.text?.value
        const attachments = ((create.bodyStructure?.subParts ?? []) as Raw[]).filter((p) => p.blobId).map((p) => ({ blobId: p.blobId, name: p.name, type: p.type, size: blobs[p.blobId]?.data.length ?? 0 }))
        emails.push({
          id: newId, threadId: create.inReplyTo ? emails.find((e) => e.messageId?.[0] === create.inReplyTo[0])?.threadId ?? newId : newId,
          mailboxIds: create.mailboxIds, keywords: create.keywords ?? {}, subject: create.subject ?? '', from: create.from ?? [], to: create.to ?? [], cc: create.cc,
          receivedAt: new Date().toISOString(), messageId: create.messageId, inReplyTo: create.inReplyTo, references: create.references,
          text, html, attachments, extraHeaders: create['header:X-Superego-Markdown'] ? { 'X-Superego-Markdown': create['header:X-Superego-Markdown'] } : {},
        })
        out.created[key] = { id: newId, threadId: newId }
      }
      for (const x of (args.destroy ?? []) as string[]) {
        const i = emails.findIndex((e) => e.id === x)
        if (i < 0) out.notDestroyed[x] = { type: 'notFound' }
        else { emails.splice(i, 1); out.destroyed.push(x) }
      }
      bump()
      return out
    },
    'Identity/get': () => ({ list: [{ id: 'id-1', email: 'me@example.com', name: 'Mikkel', isDefault: true }] }),
    'EmailSubmission/set': (args) => {
      const create = args.create.send
      const e = emails.find((m) => m.id === create.emailId)
      if (!e) return { notCreated: { send: { type: 'notFound' } } }
      sent.push({ emailId: create.emailId, identityId: create.identityId })
      const patch = args.onSuccessUpdateEmail?.['#send']
      if (patch) apply(e as unknown as Raw, patch)
      bump()
      return { created: { send: { id: id('sub') } } }
    },
    'AddressBook/get': () => ({ list: [{ id: 'ab-1', name: 'Personal', isDefault: true }] }),
    'ContactCard/query': (args) => ({
      ids: contacts.filter((c) => args.filter?.kind ? c.kind === args.filter.kind : args.filter?.email ? Object.values(c.emails ?? {}).some((x: any) => x.address === args.filter.email) : true).map((c) => c.id),
    }),
    'ContactCard/get': (args) => ({ list: contacts.filter((c) => (args.ids as string[]).includes(c.id)) }),
    'ContactCard/set': (args) => {
      const out: Raw = { created: {}, updated: {} }
      for (const [key, card] of Object.entries((args.create ?? {}) as Raw)) { const c = { ...card, id: id('card') }; contacts.push(c); out.created[key] = { id: c.id } }
      for (const [x, patch] of Object.entries((args.update ?? {}) as Raw)) { Object.assign(contacts.find((c) => c.id === x)!, patch); out.updated[x] = null }
      return out
    },
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end('unauthorized'); return }
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (url.pathname === '/jmap/session') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        apiUrl: `${base}/jmap/api/`, downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
        uploadUrl: `${base}/jmap/upload/{accountId}/`, eventSourceUrl: `${base}/jmap/event/?types={types}&closeafter={closeafter}&ping={ping}`,
        username: 'me@example.com',
        capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {}, 'urn:ietf:params:jmap:contacts': {} },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc', 'urn:ietf:params:jmap:submission': 'acc', 'urn:ietf:params:jmap:contacts': 'acc' },
      }))
      return
    }
    if (url.pathname === '/jmap/event/') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: state\ndata: {"changed":{}}\n\n`)
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    if (url.pathname.startsWith('/jmap/download/')) {
      const blobId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
      const blob = blobs[blobId]
      if (!blob) { res.writeHead(404).end(); return }
      res.writeHead(200, { 'content-type': blob.type }).end(blob.data)
      return
    }
    if (url.pathname.startsWith('/jmap/upload/')) {
      const blobId = id('blob')
      blobs[blobId] = { type: String(req.headers['content-type'] ?? 'application/octet-stream'), data: body }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ blobId, type: blobs[blobId]!.type, size: body.length }))
      return
    }
    if (url.pathname === '/jmap/api/') {
      const request = JSON.parse(body.toString()) as { methodCalls: [string, Raw, string][] }
      const responses: [string, Raw, string][] = []
      for (const [name, rawArgs, tag] of request.methodCalls) {
        const args: Raw = {}
        for (const [key, value] of Object.entries(rawArgs)) {
          if (key.startsWith('#')) {
            const ref = value as { resultOf: string; path: string }
            const prior = responses.find((r) => r[2] === ref.resultOf)
            args[key.slice(1)] = prior ? pointer(prior[1], ref.path) : []
          } else args[key] = value
        }
        const method = methods[name]
        responses.push(method ? [name, method(args), tag] : ['error', { type: 'unknownMethod' }, tag])
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ methodResponses: responses, sessionState: String(state) }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/jmap/session`,
    emails, sent, contacts, mailboxes,
    /** Something changed on the server's side (new mail): tell the event source. */
    bump,
    close: () => new Promise<void>((resolve) => { for (const res of streams) res.end(); server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
