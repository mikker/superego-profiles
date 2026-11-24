// @vitest-environment happy-dom
// The pane as the window draws it, over the daemon half and a fake Fastmail: setup, the list, a message in its
// sandboxed frame, triage, and the card that asks before the agent sends.
import { afterEach, expect, it } from 'vitest'
import { callTool, daemonMachine, mountUi, say, testDaemon, type TestDaemon, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'
import { startFakeJmap, TOKEN, type FakeJmap } from './fake-jmap.ts'
import { PENDING, STATE, type EmailState, type PendingSend } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname
let daemon: TestDaemon | undefined
let server: FakeJmap | undefined
let shown: TestWindow | undefined
afterEach(async () => { await shown?.unmount(); await daemon?.close(); await server?.close(); shown = daemon = server = undefined })

async function start(model: NonNullable<Parameters<typeof testDaemon>[0]>['model'] = [say('ok')], token = true) {
  server = await startFakeJmap()
  daemon = await testDaemon({ profile, profileName: 'email', model })
  const thread = await daemon.thread()
  await daemon.reload()
  await daemon.dispatch('settings.set', { key: 'email.sessionUrl', value: server.url })
  if (token) {
    await daemon.setSecret('email.token', TOKEN)
    await (await daemon.watch<EmailState>(STATE)).until((s) => s?.state === 'ready', 'connected')
  }
  shown = await mountUi({ machines: [daemonMachine(daemon)], profile: { extensions: [ui] } })
  return thread
}

it('asks for the token where to set it', async () => {
  const thread = await start(undefined, false)
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await shown!.until(() => pane.text().includes('Settings → Email'), 'the setup note')
})

it('lists the inbox, shows a message in a sandboxed frame, and marks it read', async () => {
  const thread = await start()
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await shown!.until(() => pane.text().includes('The Weekly Digest'), 'the inbox')
  expect(pane.text()).toContain('Re: Lunch on Friday?')
  expect(pane.text()).not.toContain('Ignored thing')
  expect(pane.text()).toContain('1 ignored (flagged) thread')
  // Triage starts at the oldest thread.
  await shown!.until(() => Boolean(pane.find('iframe.em-frame')), 'a message')
  expect(pane.find('.em-subject')?.textContent).toBe('You won a prize')
  await pane.click('The Weekly Digest')
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'The Weekly Digest', 'the digest')
  const frame = pane.find('iframe.em-frame') as HTMLIFrameElement
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals')
  const doc = frame.getAttribute('srcdoc')!
  expect(doc).toContain("script-src 'none'")
  expect(doc).toContain('snailblaze-designed')
  expect(doc).not.toContain('<script>')
  expect(doc).toContain('src="data:image/png;base64,')
  expect(pane.text()).toContain('This message contains remote content.')
  expect(pane.text()).toContain('invoice.pdf')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm3')!.keywords.$seen === true, 'marked read')
})

it('archives the thread shown with its button, moves on, and undoes', async () => {
  const thread = await start()
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'You won a prize', 'the oldest thread')
  await pane.click('.em-toolbar [aria-label="Archive"]')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm5')!.mailboxIds['mb-archive'] === true, 'archived')
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'Re: Lunch on Friday?', 'the next one')
  await shown!.until(() => pane.text().includes('archived 1 message'), 'the status')
  await pane.click('.em-toolbar [aria-label="Undo archive"]')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm5')!.mailboxIds['mb-inbox'] === true, 'back in the inbox')
})

it('triages from the keyboard: a archives, u undoes, k moves to the next thread', async () => {
  const thread = await start()
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'You won a prize', 'the oldest thread')
  const press = (key: string) => pane.find('.em')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  press('k')
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'Re: Lunch on Friday?', 'the next thread')
  expect(document.activeElement).toBe(pane.find('.em'))
  press('a')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm1')!.mailboxIds['mb-archive'] === true, 'archived')
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'The Weekly Digest', 'up to the next newer thread')
  await shown!.until(() => pane.text().includes('archived 2 messages'), 'the status')
  expect(document.activeElement).toBe(pane.find('.em'))
  press('u')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm1')!.mailboxIds['mb-inbox'] === true, 'undone')
})

it('replies from the pane: the composer starts quoted, and Send & Archive sends and archives', async () => {
  const thread = await start()
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await pane.click('Re: Lunch on Friday?')
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'Re: Lunch on Friday?', 'the thread')
  await pane.click('.em-toolbar [aria-label="Reply"]')
  await shown!.until(() => Boolean(pane.find('.em-compose')), 'the composer')
  expect((pane.find('.em-compose input') as HTMLInputElement).value).toBe('Ada Lovelace <ada@example.com>')
  expect((pane.find('.em-body') as HTMLTextAreaElement).value).toMatch(/wrote:\n> Make it noon\./)
  await pane.click('Send & Archive')
  await shown!.until(() => server!.sent.length === 1, 'sent')
  await shown!.until(() => server!.emails.find((e) => e.id === 'm2')!.mailboxIds['mb-archive'] === true, 'archived')
  await shown!.until(() => !pane.find('.em-compose'), 'the composer closed')
})

it('asks over the composer before the agent sends, and sends on yes', async () => {
  const thread = await start([
    callTool('email_draft', { to: 'bob@example.com', subject: 'Hello Bob', body: 'Hi Bob' }),
    callTool('email_send', { draft_id: 'draft-1' }),
    say('Sent.'),
  ])
  await daemon!.dispatch('thread.send', { thread: thread.id, text: 'Write Bob' })
  await (await daemon!.watch<PendingSend[]>(PENDING, { scope: thread.id })).until((p) => p?.length === 1, 'waiting')
  const card = await shown!.render({ slot: 'composer.above', thread: thread.id })
  await shown!.until(() => card.text().includes('Hello Bob'), 'the card')
  expect(card.text()).toContain('bob@example.com')
  expect(server!.sent).toEqual([])
  await card.click('Send')
  await daemon!.idle(thread)
  expect(server!.sent).toHaveLength(1)
})

it('copies an email:<id> reference from the toolbar', async () => {
  const thread = await start()
  const pane = await shown!.render({ pane: { kind: 'email' }, thread: thread.id })
  await shown!.until(() => pane.find('.em-subject')?.textContent === 'You won a prize', 'the oldest thread')
  let copied = ''
  const origExec = document.execCommand
  document.execCommand = () => false
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied = text } },
  })
  try {
    await pane.click('.em-toolbar [aria-label="Copy reference"]')
    await shown!.until(() => copied !== '', 'copied')
    expect(copied).toBe('[You won a prize](email:m5)')
    await shown!.until(() => pane.text().includes('copied reference'), 'status')
  } finally {
    document.execCommand = origExec
  }
})

it('shows the inbox count in the header', async () => {
  const thread = await start()
  const header = await shown!.render({ view: 'email.unread', place: 'header', thread: thread.id })
  await shown!.until(() => header.text().includes('4/5'), 'the count')
})
