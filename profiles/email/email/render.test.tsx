// @vitest-environment happy-dom
// How a message becomes a document: Snailblaze's presentation rules, plain text's quotes and links, and what the
// sanitizer takes out.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mountUi, type TestWindow } from 'superego/testing'
import { darkens, hasRemoteContent, linkify, messageDocument, plainTextHTML, presentation } from './render.ts'
import { renderMarkdown } from './markdown.ts'
import { groupThreads, matchSender, parseAddrs, searchConditions, type Summary } from './shared.ts'
import { htmlToText } from './text.ts'

// A window, for its DOM: the sanitizer parses with the browser's own parser.
let window: TestWindow | undefined
beforeAll(async () => { window = await mountUi({}) })
afterAll(async () => { await window?.unmount() })

it('tells designed mail from prose, and which designed mail does its own dark mode', () => {
  expect(presentation('<p>Hi <b>there</b></p>')).toBe('prose')
  expect(presentation('<table bgcolor="#fff"><tr><td>x</td></tr></table>')).toBe('designed-light')
  expect(presentation('<style>p{}</style><p>x</p>')).toBe('designed-light')
  expect(presentation('<div style="padding:0;background:#000">x</div>')).toBe('designed-light')
  expect(presentation('<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>')).toBe('designed')
  expect(presentation('<meta name="color-scheme" content="light dark"><style></style>')).toBe('designed')
  expect(darkens('<style></style>x')).toBe(true)
  expect(darkens('')).toBe(false)
})

it('sees remote images and fonts', () => {
  expect(hasRemoteContent('<img src="https://t.example/p.gif">')).toBe(true)
  expect(hasRemoteContent('<div style="background:url(\'http://x/y.png\')">')).toBe(true)
  expect(hasRemoteContent('<img src="data:image/png;base64,AA">')).toBe(false)
})

it('turns plain text into prose: nested quotes, links, addresses, escaped markup', () => {
  const html = plainTextHTML('Hi <you>\n> quoted\n> > deeper\nsee https://example.com/a?b=1. or mail ada@example.com')
  expect(html).toBe('<article class="snailblaze-plain-text">Hi &lt;you&gt;<blockquote type="cite">quoted<blockquote type="cite">deeper</blockquote></blockquote>see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a>. or mail <a href="mailto:ada@example.com">ada@example.com</a></article>')
  expect(linkify('www.example.com')).toBe('<a href="https://www.example.com">www.example.com</a>')
})

it('builds an inert document: the policy first, scripts and handlers gone, links out of the frame, remote images hidden', () => {
  const doc = messageDocument({
    html: '<html><head><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"></head><body bgcolor="#eee"><style>.x{}</style><a href="https://example.com" onclick="steal()">go</a><img src="https://t.example/p.gif"><script>alert(1)</script><iframe src="https://x"></iframe><a href="javascript:alert(1)">js</a></body></html>',
    text: '', dark: true,
  })
  const parsed = new DOMParser().parseFromString(doc, 'text/html')
  expect(parsed.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  expect(parsed.head.firstElementChild?.getAttribute('content')).toContain("script-src 'none'")
  expect(parsed.head.firstElementChild?.getAttribute('content')).toContain('img-src data:;')
  expect(parsed.querySelectorAll('script, iframe, base, meta[http-equiv="refresh"]').length).toBe(0)
  const link = parsed.querySelector('a[href^="https"]')!
  expect(link.getAttribute('onclick')).toBeNull()
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(parsed.querySelector('a:not([href])')?.textContent).toBe('js')
  expect(parsed.documentElement.className).toBe('snailblaze-designed snailblaze-paper snailblaze-darkened sg-dark')
  expect(doc).toContain('img[src^="https:" i]')
  const remote = messageDocument({ html: '<img src="https://x/y.png">', text: '', remote: true })
  expect(remote).toContain('img-src data: https: http:')
  expect(remote).not.toContain('img[src^="https:" i]')
})

it('puts designed mail with its own dark mode on paper when the pane and the system disagree', () => {
  const html = '<style>@media (prefers-color-scheme: dark){body{background:#000}}</style><p>x</p>'
  expect(messageDocument({ html, text: '', dark: true, systemDark: true })).toContain('class="snailblaze-designed sg-dark"')
  expect(messageDocument({ html, text: '', dark: true, systemDark: false })).toContain('class="snailblaze-designed snailblaze-paper snailblaze-darkened sg-dark"')
  expect(messageDocument({ html, text: '', dark: true, lightPaper: true, systemDark: false })).toContain('class="snailblaze-designed snailblaze-paper sg-dark"')
  expect(messageDocument({ html: '', text: 'plain', dark: false })).toContain('class="snailblaze-prose"')
})

it('renders Markdown as Snailblaze does', () => {
  const html = renderMarkdown('# Hi\n\n**bold** and _em_ `code` https://x.io\n\n> quoted\n\n- a\n- b\n\n1. one')
  expect(html).toContain('<h1>Hi</h1>')
  expect(html).toContain('<strong>bold</strong> and <em>em</em> <code style=')
  expect(html).toContain('<a href="https://x.io">https://x.io</a>')
  expect(html).toContain('<blockquote type="cite"')
  expect(html).toContain('<ul><li>a</li><li>b</li></ul>')
  expect(html).toContain('<ol><li>one</li></ol>')
  expect(renderMarkdown('<script>')).toContain('&lt;script&gt;')
})

it('parses address fields, sender rules and search words', () => {
  expect(parseAddrs('"Doe, Jane" <jane@x.io>; bob@y.io, nope')).toEqual({ addrs: [{ name: 'Doe, Jane', email: 'jane@x.io' }, { name: '', email: 'bob@y.io' }], invalid: ['nope'] })
  expect(matchSender([{ name: '', email: 'A@Mail.Example.com' }], ['example.com'])).toBe('example.com')
  expect(matchSender([{ name: '', email: 'a@example.com' }], ['b@example.com'])).toBeUndefined()
  expect(searchConditions('from:ada is:unread "lunch plans" has:attachment')).toEqual([
    { from: 'ada' }, { notKeyword: '$seen' }, { hasAttachment: true }, { text: 'lunch plans' },
  ])
})

it('groups messages into threads, newest first', () => {
  const m = (id: string, threadId: string, at: string, flagged = false): Summary => ({
    id, threadId, mailboxIds: [], subject: id, from: [], to: [], cc: [], replyTo: [], receivedAt: at, sentAt: null,
    seen: true, flagged, answered: false, draft: false, preview: '', hasAttachment: false,
  })
  const { threads, ignored } = groupThreads([m('a', 't1', '2026-01-01'), m('b', 't2', '2026-01-03'), m('c', 't1', '2026-01-02'), m('d', 't3', '2026-01-04', true)], { ignoreFlagged: true })
  expect(threads.map((t) => [t.key, t.messages.map((x) => x.id)])).toEqual([['t:t2', ['b']], ['t:t1', ['a', 'c']]])
  expect(ignored).toBe(1)
})

it('reads HTML as text for the agent', () => {
  expect(htmlToText('<html><head><style>x{}</style></head><body><p>Hi&nbsp;there</p><p>See <a href="https://x.io/a">the page</a></p><ul><li>one</li></ul></body></html>'))
    .toBe('Hi there\n\nSee the page (https://x.io/a)\n\n- one')
})
