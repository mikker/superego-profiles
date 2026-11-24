// email's daemon half against a fake Fastmail (fake-jmap.ts, real HTTP on localhost): connecting with the token, the
// pane's reads, triage and undo, blocked senders, drafts, and the agent's sends waiting on the user's yes.
import { afterEach, expect, it } from 'vitest'
import { callTool, say, testDaemon, type TestDaemon } from 'superego/testing'
import { startFakeJmap, TOKEN, type FakeJmap } from './fake-jmap.ts'
import { STATE, PENDING, type Detail, type EmailState, type ListResult, type PendingSend } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname
let daemon: TestDaemon | undefined
let server: FakeJmap | undefined
afterEach(async () => { await daemon?.close(); await server?.close(); daemon = undefined; server = undefined })

async function connected(model: NonNullable<Parameters<typeof testDaemon>[0]>['model'] = [say('ok')]) {
  server = await startFakeJmap()
  daemon = await testDaemon({ profile, profileName: 'email', model })
  await daemon.thread()
  await daemon.reload()
  const state = await daemon.watch<EmailState>(STATE)
  await state.until((s) => s?.state === 'no-token', 'no token yet')
  await daemon.dispatch('settings.set', { key: 'email.sessionUrl', value: server.url })
  await daemon.setSecret('email.token', TOKEN)
  await state.until((s) => s?.state === 'ready', 'connected')
  return state
}

it('says there is no token, then connects with one and lists the mailboxes', async () => {
  const state = await connected()
  const inbox = state.value.mailboxes.find((m) => m.role === 'inbox')!
  expect(inbox).toMatchObject({ name: 'INBOX', total: 5, unread: 4 })
  expect(state.value.mailboxes.map((m) => m.role ?? m.name)).toEqual(['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash', 'Newsletters', 'Work'])
  expect(state.value.username).toBe('me@example.com')
})

it('lists a mailbox as threads, newest first, leaving ignored (flagged) ones out', async () => {
  await connected()
  const list = await daemon!.call<ListResult>('email.list', { mailbox: 'inbox' })
  expect(list.threads.map((t) => t.latest.subject)).toEqual(['The Weekly Digest', 'Re: Lunch on Friday?', 'You won a prize'])
  expect(list.threads[1]!.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  expect(list.threads[1]!.unread).toBe(true)
  expect(list.ignored).toBe(1)
  const all = await daemon!.call<ListResult>('email.list', { mailbox: 'inbox', showIgnored: true })
  expect(all.threads).toHaveLength(4)
  const found = await daemon!.call<ListResult>('email.list', { mailbox: 'inbox', search: 'from:ada' })
  expect(found.threads.map((t) => t.key)).toEqual(['t:t1'])
})

it('reads a message with its inline images resolved and its real attachments', async () => {
  await connected()
  const detail = await daemon!.call<Detail>('email.message', { id: 'm3' })
  expect(detail.html).toContain('src="data:image/png;base64,')
  expect(detail.html).not.toContain('cid:logo')
  expect(detail.attachments.map((a) => a.name)).toEqual(['invoice.pdf'])
  const thread = await daemon!.call<Detail>('email.message', { id: 'm2' })
  expect(thread.thread.map((m) => m.id)).toEqual(['m1', 'm2'])
  expect(thread.text).toBe('Make it noon.\n\nAda')
  expect(thread.html).toBe('')
})

it('archives a whole thread, and undoes it', async () => {
  const state = await connected()
  const result = await daemon!.dispatch<{ status: string }>('email.act', { ids: ['m2'], mode: 'archive', mailbox: 'mb-inbox' })
  expect(result.status).toBe('archived 2 messages')
  expect(server!.emails.find((e) => e.id === 'm1')!.mailboxIds).toEqual({ 'mb-archive': true })
  // Labels it had besides the inbox stay.
  expect(server!.emails.find((e) => e.id === 'm2')!.mailboxIds).toEqual({ 'mb-work': true, 'mb-archive': true })
  await state.until((s) => s.undo === 'archive', 'undo offered')
  await daemon!.dispatch('email.undo')
  expect(server!.emails.find((e) => e.id === 'm1')!.mailboxIds).toEqual({ 'mb-inbox': true })
  expect(server!.emails.find((e) => e.id === 'm2')!.mailboxIds).toEqual({ 'mb-inbox': true, 'mb-work': true })
})

it('keeps the token out of settings, and Undo through a reload', async () => {
  const state = await connected()
  const settings = JSON.stringify(await daemon!.call('settings.watch'))
  expect(settings).toContain('"email.token":true')
  expect(settings).not.toContain(TOKEN)
  await daemon!.dispatch('email.act', { ids: ['m5'], mode: 'archive', mailbox: 'mb-inbox' })
  await state.until((s) => s.undo === 'archive', 'undo offered')
  await daemon!.reload()
  await state.until((s) => s.state === 'ready' && s.undo === 'archive', 'undo still offered after a reload')
  await daemon!.dispatch('email.undo')
  expect(server!.emails.find((e) => e.id === 'm5')!.mailboxIds).toEqual({ 'mb-inbox': true })
})

it('reconnects when the token is replaced, and stops when it is cleared', async () => {
  const state = await connected()
  await daemon!.setSecret('email.token', null)
  await state.until((s) => s.state === 'no-token', 'no token')
  // A refresh while disconnected must not poison future refreshes once the token returns.
  await expect(daemon!.dispatch('email.refresh', {})).rejects.toThrow(/No Fastmail API token/)
  await daemon!.setSecret('email.token', TOKEN)
  await state.until((s) => s.state === 'ready', 'connected again')
})

it('junks with the junk keyword, and ignores by flagging', async () => {
  await connected()
  await daemon!.dispatch('email.act', { ids: ['m5'], mode: 'junk', mailbox: 'mb-inbox' })
  expect(server!.emails.find((e) => e.id === 'm5')).toMatchObject({ mailboxIds: { 'mb-junk': true }, keywords: { $junk: true } })
  await daemon!.dispatch('email.act', { ids: ['m3'], mode: 'ignore', mailbox: 'mb-inbox' })
  expect(server!.emails.find((e) => e.id === 'm3')!.keywords.$flagged).toBe(true)
  await daemon!.dispatch('email.undo')
  expect(server!.emails.find((e) => e.id === 'm3')!.keywords.$flagged).toBeUndefined()
})

it('blocks a sender: their thread goes to Junk now, and their mail is swept out of the inbox on the next load', async () => {
  const state = await connected()
  const result = await daemon!.dispatch<{ status: string }>('email.block', { id: 'm5', domain: true, mailbox: 'mb-inbox' })
  expect(result.status).toMatch(/^blocked spam\.example\.net; junked/)
  await state.until((s) => s.prefs.blockedSenders.includes('spam.example.net'), 'the block list')
  server!.emails.push({ ...server!.emails.find((e) => e.id === 'm5')!, id: 'm6', threadId: 't6', mailboxIds: { 'mb-inbox': true }, keywords: {}, subject: 'Another prize', from: [{ email: 'x@mail.spam.example.net' }] })
  const list = await daemon!.call<ListResult>('email.list', { mailbox: 'inbox' })
  expect(list.note).toBe('blocked 1 message(s)')
  expect(list.threads.map((t) => t.latest.id)).not.toContain('m6')
  expect(server!.emails.find((e) => e.id === 'm6')!.mailboxIds).toEqual({ 'mb-junk': true })
})

it('files a newsletter: the sender joins the contact group, the thread moves to Newsletters', async () => {
  await connected()
  const result = await daemon!.dispatch<{ status: string }>('email.newsletter', { id: 'm3', mailbox: 'mb-inbox' })
  expect(result.status).toBe('added news@letters.example.org to Newsletters + moved to Newsletters 1 message')
  const group = server!.contacts.find((c) => c.kind === 'group')!
  const card = server!.contacts.find((c) => c.kind !== 'group')!
  expect(group.members).toEqual({ [card.uid]: true })
  expect(server!.emails.find((e) => e.id === 'm3')!.mailboxIds).toEqual({ 'mb-news': true })
})

it('saves a reply draft threaded onto its original, and sends it from the pane', async () => {
  await connected()
  const reply = await daemon!.call<{ to: string; subject: string; body: string; inReplyTo: string }>('email.reply', { id: 'm2', all: true })
  expect(reply).toMatchObject({ to: 'Ada Lovelace <ada@example.com>', cc: 'Grace <grace@example.com>', subject: 'Re: Lunch on Friday?', inReplyTo: 'm2' })
  expect(reply.body).toMatch(/^\n\nOn .+, Ada Lovelace <ada@example.com> wrote:\n> Make it noon\.\n> \n> Ada\n$/)
  const draft = { ...reply, bcc: '', markdown: true, body: `**Noon** works.${reply.body}`, attachments: [], replaces: null }
  const result = await daemon!.dispatch<{ id: string; status: string }>('email.send', { draft, archive: { ids: ['m2'], mailbox: 'mb-inbox' } })
  expect(result.status).toBe('sent + archived 2 messages')
  const sentMail = server!.emails.find((e) => e.id === result.id)!
  expect(sentMail).toMatchObject({ mailboxIds: { 'mb-sent': true }, inReplyTo: ['m2@example.com'], references: ['m1@example.com', 'm2@example.com'] })
  expect(sentMail.html).toContain('<strong>Noon</strong> works.')
  expect(server!.sent).toEqual([{ emailId: result.id, identityId: 'id-1' }])
  expect(server!.emails.find((e) => e.id === 'm2')!.keywords.$answered).toBe(true)
})

it('the agent drafts and sends only once the user says yes', async () => {
  await connected([
    callTool('email_draft', { reply_to: 'm1', body: 'See you then.' }),
    callTool('email_send', { draft_id: 'draft-1' }),
    say('Sent.'),
  ])
  const thread = await daemon!.thread()
  await daemon!.dispatch('thread.send', { thread: thread.id, text: 'Say yes to Ada' })
  const pending = await daemon!.watch<PendingSend[]>(PENDING, { scope: thread.id })
  await pending.until((p) => p?.length === 1, 'the send waiting')
  expect(pending.value[0]).toMatchObject({ to: 'Ada Lovelace <ada@example.com>', subject: 'Re: Lunch on Friday?', from: 'Mikkel <me@example.com>' })
  expect(pending.value[0]!.body).toMatch(/^See you then\.\n\nOn /)
  expect((await daemon!.info(thread)).status).toMatchObject({ state: 'blocked', kind: 'question' })
  expect(server!.sent).toEqual([])
  await daemon!.dispatch('email.answer', { thread: thread.id, id: pending.value[0]!.id, answer: 'send' })
  await daemon!.idle(thread)
  expect(server!.sent).toHaveLength(1)
  const calls = await daemon!.toolCalls(thread)
  expect(calls.map((c) => [c.name, c.result?.text])).toEqual([
    ['email_draft', 'Saved draft draft-1: to Ada Lovelace <ada@example.com>, "Re: Lunch on Friday?".'],
    ['email_send', 'sent.'],
  ])
})

it('a declined send stays a draft', async () => {
  await connected([callTool('email_draft', { to: 'bob@example.com', subject: 'Hi', body: 'Hello' }), callTool('email_send', { draft_id: 'draft-1' }), say('Okay.')])
  const thread = await daemon!.thread()
  await daemon!.dispatch('thread.send', { thread: thread.id, text: 'Write Bob' })
  const pending = await daemon!.watch<PendingSend[]>(PENDING, { scope: thread.id })
  await pending.until((p) => p?.length === 1, 'the send waiting')
  await daemon!.dispatch('email.answer', { thread: thread.id, id: pending.value[0]!.id, answer: 'cancel' })
  await daemon!.idle(thread)
  expect(server!.sent).toEqual([])
  expect((await daemon!.toolCalls(thread))[1]!.result?.text).toBe('The user declined: not sent. The draft is still in Drafts.')
  expect(server!.emails.find((e) => e.id === 'draft-1')!.mailboxIds).toEqual({ 'mb-drafts': true })
})

it('the agent lists, searches, reads and archives', async () => {
  await connected([
    callTool('email_list', {}),
    callTool('email_search', { from: 'ada' }),
    callTool('email_read', { id: 'm3' }),
    callTool('email_move', { ids: ['m3'], to: 'archive' }),
    say('Done.'),
  ])
  const thread = await daemon!.thread('Tidy my inbox')
  const calls = await daemon!.toolCalls(thread)
  expect(calls.every((c) => !c.result?.isError)).toBe(true)
  expect(calls[0]!.result?.text).toMatch(/^Inbox: 3 threads \(4 unread messages\), 1 ignored\n- m3 ·/)
  expect(calls[1]!.result?.text).toMatch(/^2 matches\n- m2 /)
  expect(calls[2]!.result?.text).toContain('Attachments: invoice.pdf (application/pdf, 1 KB)')
  expect(calls[2]!.result?.text).toContain('This week in things.')
  expect(calls[3]!.result?.text).toBe('archived 1 message')
})

it('hears Fastmail push and moves the version on', async () => {
  const state = await connected()
  const before = state.value.version
  server!.bump()
  await state.until((s) => s.version > before, 'a new version after a push')
})
