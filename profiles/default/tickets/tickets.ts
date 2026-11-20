// Tickets as tk writes them, read without tk: a file's frontmatter and title, and filtering, sorting and searching a
// folder's tickets. No I/O here (index.ts reads the folder), so both halves and the tests can use it.
import type { Counts, StatusFilter, Ticket, TicketRef, TicketRow } from './shared.ts'

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const LIST_KEYS = new Set(['deps', 'links', 'tags'])
const KNOWN = new Set(['id', 'status', 'type', 'priority', 'deps', 'links', 'tags', 'parent', 'assignee', 'external-ref', 'created', 'title'])
export const DEFAULT_PRIORITY = 2

/**
 * A ticket from its file's text. Forgiving: CRLF, a BOM, no frontmatter or one never closed, quoted values, lists in
 * flow (`[a, b]`) or block (`- a`) form or as a bare word, priorities like `P1` or out of range, and no `# Title`.
 * `file` is its name in `.tickets`: its id when the frontmatter has none.
 */
export function parseTicket(text: string, file: string, mtime = 0): Ticket {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let fields: Record<string, string | string[]> = {}
  let rest = lines
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
    if (end > 0) {
      fields = parseFields(lines.slice(1, end))
      rest = lines.slice(end + 1)
    }
  }

  const heading = rest.findIndex((line) => /^#\s+\S/.test(line))
  // The title is the first level-1 heading, so long as only blank lines come before it.
  const titled = heading >= 0 && rest.slice(0, heading).every((line) => !line.trim())
  const fallbackTitle = scalar(fields.title)
  const title = titled ? rest[heading]!.replace(/^#\s+/, '').trim() : fallbackTitle || ''
  const body = (titled ? rest.slice(heading + 1) : rest).join('\n').replace(/^\s*\n/, '').trimEnd()

  const id = scalar(fields.id) || file.replace(/\.md$/i, '')
  const extra: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) if (!KNOWN.has(key)) extra[key] = Array.isArray(value) ? value.join(', ') : value

  return {
    id, file, title: title || id,
    status: (scalar(fields.status) || 'open').toLowerCase().replace(/[\s-]+/g, '_'),
    type: (scalar(fields.type) || 'task').toLowerCase(),
    priority: priorityOf(scalar(fields.priority)),
    deps: list(fields.deps), links: list(fields.links), tags: list(fields.tags),
    parent: scalar(fields.parent) || undefined,
    assignee: scalar(fields.assignee) || undefined,
    externalRef: scalar(fields['external-ref']) || undefined,
    created: scalar(fields.created) || undefined,
    mtime, body, extra,
  }
}

/** `key: value` lines; a key with no value followed by `- item` lines is a list. Comments and other lines are skipped. */
function parseFields(lines: string[]): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {}
  let open: string | undefined
  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && open) {
      const value = fields[open]
      fields[open] = [...(Array.isArray(value) ? value : []), unquote(item[1]!.trim())].filter(Boolean)
      continue
    }
    const field = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/.exec(line.trimEnd())
    if (!field) { if (!/^\s/.test(line)) open = undefined; continue }
    const key = field[1]!.toLowerCase()
    const raw = (field[2] ?? '').trim()
    open = raw ? undefined : key
    fields[key] = raw.startsWith('[') && raw.endsWith(']') ? splitFlow(raw.slice(1, -1)) : unquote(raw)
  }
  return fields
}

/** `a, "b, c", 'd'` → its items. */
function splitFlow(inner: string): string[] {
  const items: string[] = []
  let current = ''
  let quote: string | undefined
  for (const ch of inner) {
    if (quote) { current += ch; if (ch === quote) quote = undefined }
    else if (ch === '"' || ch === "'") { current += ch; quote = ch }
    else if (ch === ',') { items.push(current); current = '' }
    else current += ch
  }
  items.push(current)
  return items.map((item) => unquote(item.trim())).filter(Boolean)
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  return value
}

const scalar = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : value ?? '').trim()

/** A list field: a list as it is; a bare value split on commas (`tags: ui, backend`); nothing for empty. */
function list(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

function priorityOf(value: string): number {
  const n = Number.parseInt(value.replace(/^p/i, ''), 10)
  return Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : DEFAULT_PRIORITY
}

// ── Statuses ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const isOpen = (status: string) => status === 'open' || status === 'in_progress'

/** Whether a ticket with `status` shows under `filter`. Odd statuses (`tombstone`, `failed`) show only under All. */
export function shows(status: string, filter: StatusFilter | string): boolean {
  if (filter === 'all') return true
  if (filter === 'open') return isOpen(status)
  return status === filter
}

export function countOf(tickets: Iterable<Ticket>): Counts {
  const counts: Counts = { open: 0, in_progress: 0, closed: 0, all: 0 }
  for (const t of tickets) {
    counts.all++
    if (t.status === 'open' || t.status === 'in_progress' || t.status === 'closed') counts[t.status]++
  }
  return counts
}

// ── Queries ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Filters = {
  status?: StatusFilter | string
  type?: string
  /** Exactly this priority. */
  priority?: number
  tag?: string
  /** A part of the assignee's name. */
  assignee?: string
  parent?: string
}

export type Query = Filters & { words: string[] }

/**
 * A search box's text: words to find, and filters written in it: `type:bug`, `tag:ui` or `#ui`, `p1` or `p:1`,
 * `assignee:mikkel`, `parent:ab-12`, `status:in_progress`.
 */
export function parseQuery(text: string): Query {
  const query: Query = { words: [] }
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const field = /^(type|tag|p|priority|assignee|parent|status):(.+)$/i.exec(token)
    const key = field?.[1]!.toLowerCase()
    const value = field?.[2]!
    if (key === 'type') query.type = value.toLowerCase()
    else if (key === 'tag') query.tag = value.toLowerCase()
    else if (key === 'assignee') query.assignee = value.toLowerCase()
    else if (key === 'parent') query.parent = value
    else if (key === 'status') query.status = value.toLowerCase()
    else if ((key === 'p' || key === 'priority') && /^[0-4]$/.test(value)) query.priority = Number(value)
    else if (/^#[^#\s]+$/.test(token)) query.tag = token.slice(1).toLowerCase()
    else if (/^p[0-4]$/i.test(token)) query.priority = Number(token.slice(1))
    else query.words.push(token.toLowerCase())
  }
  return query
}

function matchesFilters(t: Ticket, f: Filters): boolean {
  if (f.status && !shows(t.status, f.status)) return false
  if (f.type && t.type !== f.type.toLowerCase()) return false
  if (f.priority !== undefined && t.priority !== f.priority) return false
  if (f.tag && !t.tags.some((tag) => tag.toLowerCase() === f.tag!.toLowerCase())) return false
  if (f.assignee && !(t.assignee ?? '').toLowerCase().includes(f.assignee.toLowerCase())) return false
  if (f.parent && t.parent !== f.parent) return false
  return true
}

/**
 * How well `t` matches every word (0: it doesn't): its id best, then its title, then anywhere (tags, body). Every word
 * must be found somewhere.
 */
function score(t: Ticket, words: string[]): number {
  if (!words.length) return 1
  const id = t.id.toLowerCase()
  const title = t.title.toLowerCase()
  let haystack: string | undefined
  let total = 0
  for (const word of words) {
    if (id === word) total += 100
    else if (id.includes(word)) total += 40
    else if (title.includes(word)) total += 10
    else if ((haystack ??= `${t.tags.join(' ')}\n${t.type}\n${t.assignee ?? ''}\n${t.externalRef ?? ''}\n${t.body}`.toLowerCase()).includes(word)) total += 1
    else return 0
  }
  return total
}

/** By priority (0 first), then most recently changed. Closed tickets alone: most recently changed first. */
export function compare(filter: StatusFilter | string | undefined) {
  return (a: Ticket, b: Ticket) =>
    (filter === 'closed' ? 0 : a.priority - b.priority) || b.mtime - a.mtime || (b.created ?? '').localeCompare(a.created ?? '') || a.id.localeCompare(b.id)
}

/** The tickets a query finds, best first: matches on the id, then the title, then the rest; each sorted as `compare`. */
export function search(tickets: Iterable<Ticket>, query: Query): Ticket[] {
  const found: { t: Ticket; s: number }[] = []
  for (const t of tickets) {
    if (!matchesFilters(t, query)) continue
    const s = score(t, query.words)
    if (s) found.push({ t, s })
  }
  const order = compare(query.status)
  // Ranked in bands, so a stronger match comes first but priority still orders matches of the same kind.
  const band = (s: number) => (s >= 100 ? 3 : s >= 40 ? 2 : s >= 10 * query.words.length ? 1 : 0)
  return found.sort((a, b) => band(b.s) - band(a.s) || order(a.t, b.t)).map(({ t }) => t)
}

// ── Rows and references ──────────────────────────────────────────────────────────────────────────────────────────────

export function rowOf(t: Ticket, byId: Map<string, Ticket>): TicketRow {
  const row: TicketRow = { id: t.id, title: t.title, status: t.status, type: t.type, priority: t.priority, tags: t.tags, mtime: t.mtime }
  if (t.created) row.created = t.created
  if (t.assignee) row.assignee = t.assignee
  if (t.parent) row.parent = t.parent
  if (isOpen(t.status) && t.deps.some((d) => { const dep = byId.get(d); return Boolean(dep && isOpen(dep.status)) })) row.blocked = true
  return row
}

export const refOf = (id: string, byId: Map<string, Ticket>): TicketRef => {
  const t = byId.get(id)
  return t ? { id, title: t.title, status: t.status } : { id, missing: true }
}

/** A ticket by its id, or a part of it as tk takes (`5c4` for `nw-5c46`) when only one has that part. */
export function resolve(byId: Map<string, Ticket>, id: string): Ticket | undefined {
  const exact = byId.get(id)
  if (exact) return exact
  const needle = id.toLowerCase()
  let found: Ticket | undefined
  for (const t of byId.values()) {
    if (!t.id.toLowerCase().includes(needle)) continue
    if (found) throw new Error(`"${id}" is ambiguous: ${found.id}, ${t.id}, …`)
    found = t
  }
  return found
}

// ── For the agent ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line per ticket: id, status, priority, type, title, and its tags. */
export function formatRow(row: TicketRow): string {
  const tags = row.tags.length ? `  [${row.tags.join(', ')}]` : ''
  const blocked = row.blocked ? ' (blocked)' : ''
  return `${row.id}  ${row.status}${blocked}  P${row.priority} ${row.type}  ${row.title}${tags}`
}

const refLine = (r: TicketRef) => (r.missing ? `${r.id} (not found)` : `${r.id} [${r.status}] ${r.title}`)

/** A ticket in full, as Markdown-ish text: its fields, the tickets it names, then its title and body. */
export function formatTicket(t: Ticket, refs: { deps: TicketRef[]; links: TicketRef[]; parent?: TicketRef; children: TicketRef[] }, file?: string): string {
  const lines = [
    `id: ${t.id}`, `status: ${t.status}`, `type: ${t.type}`, `priority: ${t.priority}`,
    ...(t.assignee ? [`assignee: ${t.assignee}`] : []),
    ...(t.tags.length ? [`tags: ${t.tags.join(', ')}`] : []),
    ...(t.created ? [`created: ${t.created}`] : []),
    ...(t.externalRef ? [`external-ref: ${t.externalRef}`] : []),
    ...Object.entries(t.extra).map(([k, v]) => `${k}: ${v}`),
    ...(refs.parent ? [`parent: ${refLine(refs.parent)}`] : []),
    ...(refs.deps.length ? ['deps (it waits on these):', ...refs.deps.map((r) => `  - ${refLine(r)}`)] : []),
    ...(refs.links.length ? ['links:', ...refs.links.map((r) => `  - ${refLine(r)}`)] : []),
    ...(refs.children.length ? ['children:', ...refs.children.map((r) => `  - ${refLine(r)}`)] : []),
    ...(file ? [`file: ${file}`] : []),
  ]
  return `${lines.join('\n')}\n\n# ${t.title}\n\n${t.body}`.trimEnd()
}
