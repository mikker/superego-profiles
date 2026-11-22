// Snailblaze's small Markdown for composing email: raw HTML escaped, the formatting people use in short messages, and an
// email-safe fragment out (inline styles only, nothing remote, `> ` lines as `<blockquote type="cite">` so the other end
// shows a quote). Used to send a Markdown draft's HTML part, and for the composer's preview.

const STYLE = {
  container: "font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;",
  blockquote: 'margin: 0.8em 0; padding: 0 0 0 12px; border-left: 3px solid #c7c7cc; color: #6e6e73;',
  pre: 'margin: 0.8em 0; padding: 8px 10px; border-radius: 6px; background: rgba(127, 127, 127, 0.12); white-space: pre-wrap;',
  code: 'font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em;',
  hr: 'border: 0; border-top: 1px solid rgba(127, 127, 127, 0.35); margin: 1.2em 0;',
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderMarkdown(markdown: string): string {
  return `<div style="${STYLE.container}">\n${blocks(markdown.replace(/\r\n/g, '\n').split('\n'))}\n</div>`
}

type Item = { ordered: boolean; number: number; text: string }

function blocks(lines: string[]): string {
  const out: string[] = []
  let paragraph: string[] = []
  let items: Item[] = []
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    const first = items[0]
    if (first) {
      const lis = items.map((i) => `<li>${inline(i.text)}</li>`).join('')
      out.push(first.ordered ? `<ol${first.number === 1 ? '' : ` start="${first.number}"`}>${lis}</ol>` : `<ul>${lis}</ul>`)
    }
    items = []
  }
  const flush = () => { flushParagraph(); flushList() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (line.startsWith('```')) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) code.push(lines[i]!)
      out.push(`<pre style="${STYLE.pre}"><code style="${STYLE.code}">${escape(code.join('\n'))}</code></pre>`)
    } else if (trimmed.startsWith('>')) {
      flush()
      const quoted: string[] = []
      let inner: string | undefined
      while (i < lines.length && (inner = quoteContent(lines[i]!)) !== undefined) { quoted.push(inner); i++ }
      i--
      out.push(`<blockquote type="cite" style="${STYLE.blockquote}">\n${blocks(quoted)}\n</blockquote>`)
    } else if (!trimmed) {
      flush()
    } else if (isRule(trimmed)) {
      flush()
      out.push(`<hr style="${STYLE.hr}">`)
    } else if (heading(trimmed)) {
      flush()
      const h = heading(trimmed)!
      out.push(`<h${h.level}>${inline(h.text)}</h${h.level}>`)
    } else if (listItem(trimmed)) {
      flushParagraph()
      const item = listItem(trimmed)!
      if (items[0] && items[0].ordered !== item.ordered) flushList()
      items.push(item)
    } else {
      flushList()
      paragraph.push(line)
    }
  }
  flush()
  return out.join('\n')
}

function quoteContent(line: string): string | undefined {
  const content = line.replace(/^ +/, '')
  if (!content.startsWith('>')) return undefined
  const inner = content.slice(1)
  return inner.startsWith(' ') ? inner.slice(1) : inner
}

function isRule(line: string) {
  const chars = line.replace(/ /g, '')
  return chars.length >= 3 && '-*_'.includes(chars[0]!) && [...chars].every((c) => c === chars[0])
}

function heading(line: string) {
  const m = /^(#{1,6}) (.*)$/.exec(line)
  return m ? { level: m[1]!.length, text: m[2]! } : undefined
}

function listItem(line: string): Item | undefined {
  if (/^[-*+] /.test(line)) return { ordered: false, number: 0, text: line.slice(2) }
  const m = /^(\d{1,9})[.)] (.*)$/.exec(line)
  return m ? { ordered: true, number: Number(m[1]), text: m[2]! } : undefined
}

// Code spans, links, bare URLs and addresses are matched on the raw text so they never get emphasis; the rest is
// escaped, then emphasised.
const TOKENS = new RegExp([
  /`([^`]+)`/.source,
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.source,
  /(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])/.source,
  /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/.source,
].join('|'), 'g')

function inline(source: string): string {
  let out = ''
  let at = 0
  for (const m of source.matchAll(TOKENS)) {
    out += emphasize(escape(source.slice(at, m.index)))
    if (m[1] !== undefined) out += `<code style="${STYLE.code}">${escape(m[1])}</code>`
    else if (m[2] !== undefined) out += `<a href="${escape(m[3]!)}">${emphasize(escape(m[2]))}</a>`
    else if (m[4] !== undefined) out += `<a href="${escape(m[4])}">${escape(m[4])}</a>`
    else if (m[5] !== undefined) out += `<a href="mailto:${escape(m[5])}">${escape(m[5])}</a>`
    at = m.index! + m[0].length
  }
  return out + emphasize(escape(source.slice(at)))
}

function emphasize(value: string): string {
  return value
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?=[^\s*])([^*]+?)(?<=\S)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<!\w)_(?=[^\s_])([^_]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
}
