// How a message is shown: Snailblaze's rendering, for a sandboxed frame instead of a WKWebView. The email becomes a
// complete, inert document: a restrictive Content Security Policy first (no scripts, forms, frames, or remote
// anything unless remote content is allowed), then Snailblaze's stylesheet, then the message. HTML that brings its own
// design is kept as designed (on light "paper", darkened in dark mode unless it supports dark mode itself); plain text
// and unstyled HTML become Snailblaze's prose. After it loads, the pane runs the same fix-ups Snailblaze runs in the
// page (it can: the frame is same-origin but runs no scripts of its own): keep mail that paints its own dark page as
// it is, zoom wide designed mail out to fit, and reader mode.

export type Presentation = 'prose' | 'designed' | 'designed-light'

const DESIGNED = /<[a-z][^>]*\s(?:bgcolor\s*=|background\s*=|style\s*=[^>]*background)/is
const DARK_SUPPORT = /(?:prefers-color-scheme\s*:\s*dark|<meta\b[^>]*color-scheme[^>]*dark|color-scheme\s*:[^;}"']*dark)/is
const STYLESHEET_LINK = /<link\b[^>]*\brel\s*=\s*(["'])[^"']*stylesheet[^"']*\1[^>]*>/is
const STYLE_TAG = /<style\b[^>]*>/is

/** HTML that brings its own stylesheet or paints its own backgrounds is designed; everything else is prose. */
export function presentation(html: string): Presentation {
  if (!STYLESHEET_LINK.test(html) && !STYLE_TAG.test(html) && !DESIGNED.test(html)) return 'prose'
  return DARK_SUPPORT.test(html) ? 'designed' : 'designed-light'
}

/** Whether dark mode darkens this message (so the reader can ask for light paper instead). */
export const darkens = (html: string) => Boolean(html.trim()) && presentation(html) === 'designed-light'

const REMOTE_IMAGES = /(?:<(?:img|image)\b[^>]*(?:src|srcset|href|xlink:href)\s*=\s*(?:["']\s*)?https?:\/\/|url\(\s*(?:["']\s*)?https?:\/\/)/is
export const hasRemoteContent = (html: string) => REMOTE_IMAGES.test(html) || /@font-face\b[^}]*url\(\s*(?:["']\s*)?https?:\/\//is.test(html)

export const escapeHTML = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Plain text: `>` quotes as nested blockquotes, links and addresses as links.

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]'}]|\bmailto:[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

export function linkify(value: string): string {
  let out = ''
  let at = 0
  for (const m of value.matchAll(LINK)) {
    out += escapeHTML(value.slice(at, m.index))
    const raw = m[0]
    const href = /^https?:\/\//i.test(raw) || /^mailto:/i.test(raw) ? raw : /^www\./i.test(raw) ? `https://${raw}` : `mailto:${raw}`
    out += `<a href="${escapeHTML(href)}">${escapeHTML(raw)}</a>`
    at = m.index! + raw.length
  }
  return out + escapeHTML(value.slice(at))
}

function quoteDepth(line: string): [number, string] {
  let depth = 0
  let rest = line
  for (;;) {
    const trimmed = rest.replace(/^ +/, '')
    if (!trimmed.startsWith('>')) break
    depth++
    rest = trimmed.slice(1)
  }
  if (depth && rest.startsWith(' ')) rest = rest.slice(1)
  return [depth, depth ? rest : line]
}

export function plainTextHTML(text: string): string {
  let out = ''
  let depth = 0
  let run: string[] = []
  const flush = () => { out += linkify(run.join('\n')); run = [] }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const [d, content] = quoteDepth(line)
    if (d !== depth) {
      flush()
      out += d > depth ? '<blockquote type="cite">'.repeat(d - depth) : '</blockquote>'.repeat(depth - d)
      depth = d
    }
    run.push(content)
  }
  flush()
  out += '</blockquote>'.repeat(depth)
  return `<article class="snailblaze-plain-text">${out}</article>`
}

/** The window's colours, so prose sits on the pane as if it were part of it. */
export type Palette = { bg: string; fg: string; muted: string; link: string; border: string; code: string }

/** Elements that show pictures rather than sender colours, given the filter again when darkened. */
const PICTURES = 'img, picture, video, canvas, iframe, [background], [style*="background-image" i], [style*="url(" i]'

function stylesheet(palette: Palette | undefined, darkPaper: string) {
  const light = { bg: '#ffffff', fg: '#1d1d1f', muted: '#6e6e73', link: '#0a66d9', border: '#d8d8dc', code: '#f3f3f5' }
  const dark = { bg: '#1e1e1e', fg: '#e8e8ea', muted: '#a1a1a6', link: '#6cb0ff', border: '#3a3a3c', code: '#2a2a2d' }
  const vars = (p: typeof light) => `--snailblaze-bg: ${p.bg}; --snailblaze-fg: ${p.fg}; --snailblaze-secondary: ${p.muted}; --snailblaze-link: ${p.link}; --snailblaze-border: ${p.border}; --snailblaze-code-bg: ${p.code};`
  return `
:root { color-scheme: light; ${vars(light)} --snailblaze-quote-1: #6f9ce8; --snailblaze-quote-2: #5fb383; --snailblaze-quote-3: #d9955a; }
:root.sg-dark { color-scheme: dark; ${vars(dark)} --snailblaze-quote-1: #5a86d0; --snailblaze-quote-2: #4f9a6e; --snailblaze-quote-3: #bf8350; }
${palette ? `:root.sg-themed { ${vars(palette)} }` : ''}
@media print { :root, :root.sg-dark { color-scheme: light; ${vars(light)} } }

img, video { max-width: 100%; height: auto; }

/* Designed HTML: keep the sender's layout, add room around it. Unstyled text gets a mail client's sans-serif. */
:where(.snailblaze-designed) { font-family: -apple-system, system-ui, "Helvetica Neue", Helvetica, sans-serif; }
.snailblaze-designed body { margin: 0 !important; padding: 12px 20px 20px !important; overflow-wrap: break-word; }
.snailblaze-designed table { max-width: 100%; }
.snailblaze-paper { color-scheme: light; }
/* The paper is the page canvas, not the body, so a cleared body background still shows paper. */
:where(.snailblaze-paper) { background: #ffffff; }
:where(.snailblaze-paper) body { color: #1d1d1f; box-sizing: border-box; min-height: 100vh; }
/* Darkened paper: in dark mode the whole page is inverted with its hue kept, and pictures inverted back. */
@media screen {
  :where(.sg-dark.snailblaze-darkened) { background: ${darkPaper}; }
  .sg-dark.snailblaze-darkened,
  .sg-dark.snailblaze-darkened :is(${PICTURES}):not(:is(${PICTURES}) *) { filter: invert(1) hue-rotate(180deg); }
}

/* Prose: plain text and unstyled HTML. */
.snailblaze-prose body {
  box-sizing: border-box; max-width: calc(72ch + 40px); margin: 0 !important; padding: 14px 20px 24px !important;
  background: var(--snailblaze-bg) !important; color: var(--snailblaze-fg) !important;
  font-family: "iA Writer Quattro V", -apple-system, system-ui, sans-serif !important;
  font-size: 15px !important; line-height: 1.5 !important; overflow-wrap: anywhere;
}
/* In dark mode, inline text colours picked for white paper follow the palette. */
.sg-dark.snailblaze-prose body [style*="color" i], .sg-dark.snailblaze-prose body font[color] { color: inherit !important; }
.sg-dark.snailblaze-prose body a[style*="color" i] { color: var(--snailblaze-link) !important; }
.snailblaze-prose body > :first-child { margin-top: 0; }
.snailblaze-prose p { margin: 0 0 0.9em; }
.snailblaze-prose h1, .snailblaze-prose h2, .snailblaze-prose h3, .snailblaze-prose h4 { font-weight: 600; line-height: 1.25; margin: 1.2em 0 0.5em; }
.snailblaze-prose ul, .snailblaze-prose ol { padding-left: 1.4em; margin: 0.5em 0; }
.snailblaze-prose li + li { margin-top: 0.25em; }
.snailblaze-prose a { color: var(--snailblaze-link); text-underline-offset: 2px; text-decoration-thickness: 1px; }
.snailblaze-prose hr { border: 0; border-top: 1px solid var(--snailblaze-border); margin: 1.2em 0; }
.snailblaze-prose blockquote { margin: 0.5em 0 !important; padding: 0 0 0 12px !important; border: 0 !important; border-left: 2px solid var(--snailblaze-quote-1) !important; color: var(--snailblaze-secondary); }
.snailblaze-prose blockquote blockquote { border-left-color: var(--snailblaze-quote-2) !important; }
.snailblaze-prose blockquote blockquote blockquote { border-left-color: var(--snailblaze-quote-3) !important; }
.snailblaze-prose .gmail_attr { color: var(--snailblaze-secondary); }
.snailblaze-prose code, .snailblaze-prose pre, .snailblaze-prose kbd, .snailblaze-prose samp { font-family: ui-monospace, "SF Mono", Menlo, monospace !important; font-size: 0.88em; }
.snailblaze-prose code { background: var(--snailblaze-code-bg); border-radius: 4px; padding: 0.1em 0.3em; }
.snailblaze-prose pre { background: var(--snailblaze-code-bg); border-radius: 6px; padding: 10px 12px; line-height: 1.45; white-space: pre-wrap; }
.snailblaze-prose pre code { background: none; padding: 0; font-size: inherit; }
.snailblaze-prose table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; overflow-wrap: normal; }
.snailblaze-prose th, .snailblaze-prose td { border-color: var(--snailblaze-border); padding: 4px 8px; text-align: left; vertical-align: top; }
.snailblaze-prose .snailblaze-plain-text { white-space: pre-wrap; }
.snailblaze-prose .snailblaze-plain-text blockquote { margin: 0 !important; }

/* Reader mode strips sender styling entirely. */
.snailblaze-reader body * { background-color: transparent !important; color: inherit !important; }
.snailblaze-reader body a { color: var(--snailblaze-link) !important; }
.snailblaze-reader section { margin: 0 0 0.9em; }
.snailblaze-reader body blockquote { color: var(--snailblaze-secondary) !important; }
.snailblaze-reader body pre, .snailblaze-reader body :not(pre) > code { background-color: var(--snailblaze-code-bg) !important; }
`
}

const BLOCKED_IMAGES = `
img[src^="http:" i], img[src^="https:" i], img[srcset*="http:" i], img[srcset*="https:" i],
image[href^="http:" i], image[href^="https:" i], image[xlink\\:href^="http:" i], image[xlink\\:href^="https:" i] { display: none !important; }`

export type DocumentOptions = {
  html: string
  text: string
  /** Load remote images and fonts (once, or because the sender is allowed). */
  remote?: boolean
  /** Show designed mail as designed, on light paper, in dark mode. */
  lightPaper?: boolean
  /** The pane is dark (the window's theme, not the system's). */
  dark?: boolean
  /** The system's preference (what the message's own `prefers-color-scheme` sees). */
  systemDark?: boolean
  palette?: Palette
}

/** The complete document for a message, as a string for a sandboxed frame's `srcdoc`. */
export function messageDocument({ html, text, remote = false, lightPaper = false, dark = false, systemDark = dark, palette }: DocumentOptions): string {
  const body = html.trim()
  let classes: string
  let content: string
  if (body) {
    let kind = presentation(body)
    // Mail that does its own dark mode follows the system; when the pane's theme disagrees, put it on paper instead.
    if (kind === 'designed' && dark !== systemDark) kind = 'designed-light'
    classes = kind === 'prose' ? 'snailblaze-prose'
      : kind === 'designed' ? 'snailblaze-designed'
        : lightPaper ? 'snailblaze-designed snailblaze-paper' : 'snailblaze-designed snailblaze-paper snailblaze-darkened'
    content = body
  } else {
    classes = 'snailblaze-prose'
    content = plainTextHTML(text)
  }
  if (dark) classes += ' sg-dark'
  if (palette) classes += ' sg-themed'
  const images = remote ? 'data: https: http:' : 'data:'
  const fonts = remote ? 'data: https: http:' : 'data:'
  const darkPaper = palette ? invertColor(palette.bg) : '#e1e1e1'
  const document = `<!doctype html>
<html class="${classes}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta id="snailblaze-csp" http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src ${fonts}; form-action 'none'; frame-src 'none'; child-src 'none'; img-src ${images}; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; worker-src 'none'">
<style id="snailblaze-style">${stylesheet(palette, darkPaper)}${remote ? '' : BLOCKED_IMAGES}</style>
</head>
<body>${content}</body>
</html>`
  return sanitize(document)
}

/**
 * Take out of the document whatever could act: scripts and handlers, frames and plugins, refreshes and base URLs,
 * stylesheet links (the policy refuses them anyway). Links open in a new window, out of the frame; the frame's
 * sandbox lets them, and nothing else. Without a DOM (the daemon, a test without one) the policy and sandbox alone
 * hold.
 */
export function sanitize(document: string): string {
  if (typeof DOMParser === 'undefined') return document
  const doc = new DOMParser().parseFromString(document, 'text/html')
  doc.querySelectorAll('script, noscript, iframe, frame, frameset, object, embed, applet, base, link, portal, template').forEach((el) => el.remove())
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => { if (el.id !== 'snailblaze-csp') el.remove() })
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc') el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name)
    }
  }
  doc.querySelectorAll('a[href], area[href]').forEach((a) => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') })
  // The CSP must come before anything that loads: keep it first in the head.
  const csp = doc.getElementById('snailblaze-csp')
  if (csp && doc.head.firstChild !== csp) doc.head.prepend(csp)
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

function invertColor(color: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color.trim())
  if (m) return `rgb(${255 - parseInt(m[1]!, 16)}, ${255 - parseInt(m[2]!, 16)}, ${255 - parseInt(m[3]!, 16)})`
  const rgb = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(color)
  if (rgb) return `rgb(${255 - Number(rgb[1])}, ${255 - Number(rgb[2])}, ${255 - Number(rgb[3])})`
  return '#e1e1e1'
}

/** How light a CSS colour (`rgb()` or `#rrggbb`) is, 0–255. */
export function luminance(color: string): number | undefined {
  const rgb = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(color)
  if (rgb) return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color.trim())
  if (hex) return 0.2126 * parseInt(hex[1]!, 16) + 0.7152 * parseInt(hex[2]!, 16) + 0.0722 * parseInt(hex[3]!, 16)
  return undefined
}

// After it loads: run from the pane on the frame's document (the frame itself runs no scripts).

/** Some mail paints its own dark page without saying so: darkening would turn it light again, so don't. */
export function keepDarkMail(doc: Document) {
  const root = doc.documentElement
  const view = doc.defaultView
  if (!root.classList.contains('snailblaze-darkened') || !root.classList.contains('sg-dark') || !doc.body || !view) return
  const hasDarkBackground = (element: Element | null) => {
    for (let node = element; node; node = node.parentElement) {
      const [r = 0, g = 0, b = 0, alpha = 1] = (view.getComputedStyle(node).backgroundColor.match(/[\d.]+/g) || []).map(Number)
      if (alpha >= 0.5) return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
    }
    return false
  }
  let darkText = 0, allText = 0
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */)
  while (walker.nextNode()) {
    const length = (walker.currentNode.textContent ?? '').trim().length
    const parent = walker.currentNode.parentElement
    if (!length || !parent || parent.getClientRects().length === 0) continue
    allText += length
    if (hasDarkBackground(parent)) darkText += length
  }
  if (darkText > allText / 2) root.classList.remove('snailblaze-darkened')
}

/** Designed mail laid out for a fixed width (600px, usually) wider than the pane: zoom out instead of scrolling sideways. */
export function fitToWidth(doc: Document) {
  const root = doc.documentElement
  if (!root.classList.contains('snailblaze-designed') || !doc.body) return
  const body = doc.body as HTMLElement & { style: CSSStyleDeclaration & { zoom: string } }
  body.style.zoom = ''
  const overflow = root.scrollWidth / root.clientWidth
  if (overflow > 1.01) body.style.zoom = String(1 / overflow)
}

/** Reader mode: the message's main content alone, in Snailblaze's prose. */
export function readerMode(doc: Document) {
  if (!doc.body) return
  const root = doc.documentElement
  const keep = (cls: string) => root.classList.contains(cls) ? ` ${cls}` : ''
  const proseClasses = `snailblaze-prose snailblaze-reader${keep('sg-dark')}${keep('sg-themed')}`
  if (doc.body.querySelector(':scope > .snailblaze-plain-text:only-child')) { root.className = proseClasses; return }
  doc.querySelectorAll('style:not(#snailblaze-style), link[rel~="stylesheet" i]').forEach((el) => el.remove())
  const words = (el: Element) => (el.textContent || '').trim().split(/\s+/).filter(Boolean).length
  const score = (el: Element) => {
    const text = el.textContent || ''
    const w = words(el)
    const paragraphs = el.querySelectorAll('p').length
    const commas = (text.match(/,/g) || []).length
    const images = el.querySelectorAll('img').length
    const tables = el.querySelectorAll('table').length
    const linked = Array.from(el.querySelectorAll('a')).reduce((n, a) => n + (a.textContent || '').length, 0)
    const density = Math.min(linked / Math.max(text.length, 1), 0.5)
    const identity = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase()
    const bonus = /(article|content|entry|main|post|story)/.test(identity) ? 15 : 0
    return (w + paragraphs * 10 + commas + bonus - images / Math.max(w, 1) * 3 - tables * 5) * (1 - density)
  }
  const clutter = [
    'script', 'style', 'link', 'meta', 'noscript', 'template', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'aside',
    '[hidden]', '[aria-hidden="true"]', '[role="banner"]', '[role="navigation"]',
    '[class*="advert" i]', '[class*="banner" i]', '[class*="cookie" i]', '[class*="footer" i]', '[class*="menu" i]', '[class*="promo" i]',
    '[class*="related" i]', '[class*="share" i]', '[class*="social" i]', '[class*="sponsor" i]', '[class*="subscribe" i]', '[class*="tracking" i]',
    '[id*="advert" i]', '[id*="footer" i]', '[id*="promo" i]', '[id*="related" i]', '[id*="share" i]', '[id*="social" i]', '[id*="subscribe" i]',
  ].join(',')
  const presentationAttributes = ['style', 'class', 'id', 'width', 'height', 'align', 'bgcolor', 'color', 'face', 'size']
  doc.body.querySelectorAll(clutter).forEach((el) => el.remove())
  doc.body.querySelectorAll('img').forEach((img) => {
    const width = Number(img.getAttribute('width') || img.naturalWidth || 0)
    const height = Number(img.getAttribute('height') || img.naturalHeight || 0)
    if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) img.remove()
  })
  const candidates = Array.from(doc.body.querySelectorAll('article, [role="article"], main, [role="main"], .post-content, .post-body, .article-content, .entry-content, .markdown-body, .article-body, section, td, div'))
  const best = candidates.reduce<{ el: Element | null; score: number }>((winner, el) => {
    const value = score(el)
    return value > winner.score ? { el, score: value } : winner
  }, { el: null, score: 50 })
  const content = (best.el || doc.body).cloneNode(true) as Element
  content.querySelectorAll('table').forEach((table) => {
    const rows = Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'))
    const layout = !table.querySelector('th') && rows.length > 0 && rows.every((row) => row.querySelectorAll(':scope > td').length <= 1)
    if (!layout) return
    const fragment = doc.createDocumentFragment()
    for (const row of rows) {
      const cell = row.querySelector(':scope > td')
      if (!cell) continue
      const block = doc.createElement('section')
      while (cell.firstChild) block.appendChild(cell.firstChild)
      fragment.appendChild(block)
    }
    table.replaceWith(fragment)
  })
  content.querySelectorAll('*').forEach((el) => {
    const keepsClass = el.classList.contains('snailblaze-plain-text')
    presentationAttributes.filter((a) => !(keepsClass && a === 'class')).forEach((a) => el.removeAttribute(a))
  })
  doc.body.replaceChildren(...Array.from(content.childNodes))
  presentationAttributes.forEach((a) => doc.body.removeAttribute(a))
  root.className = proseClasses
  root.scrollTop = 0
  doc.body.scrollTop = 0
}
