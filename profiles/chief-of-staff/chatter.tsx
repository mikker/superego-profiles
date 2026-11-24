// Collapses cross-thread chatter (reports from children, messages from the lead, watchdog notices, queue starts,
// board relays) into compact expandable one-line rows in the transcript via `composer.sentWith`.
import { useState } from 'react'
import { CaretRightIcon, Markdown, ThreadRef, type MachineEntry, type SentBlock, type SentWith, type ThreadInfo } from 'superego/ui'

export type ChatterItem = {
  kind: 'from' | 'watchdog' | 'queued' | 'relay'
  /** The thread referenced in the first line, if any. */
  threadId?: string
  threadTitle?: string
  /** Short one-line summary shown while collapsed. */
  summary: string
  /** Full original text shown when expanded. */
  body: string
}

const THREAD_LINK = /\[([^\]]+)\]\(thread:([^)]+)\)/

function parseOne(raw: string): ChatterItem | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const firstLine = trimmed.split('\n')[0]!.trim()

  // "From [Title](thread:123): finished." / "From [Lead](thread:4797):"
  if (firstLine.startsWith('From ')) {
    const m = /^From \[([^\]]+)\]\(thread:([^)]+)\):\s*(.*)$/.exec(firstLine)
    if (!m) return undefined
    const [, title, id, rest] = m
    const nextLine = trimmed.split('\n').slice(1).find((l) => l.trim())?.trim()
    const tail = rest || (nextLine ? nextLine.slice(0, 80) : '')
    return {
      kind: 'from',
      threadId: id,
      threadTitle: title,
      summary: tail || 'message',
      body: trimmed,
    }
  }

  // "Watchdog: [Smoke](thread:123) has made no progress for 15 min, in bash (`sleep 960`)."
  if (firstLine.startsWith('Watchdog:')) {
    const m = THREAD_LINK.exec(firstLine)
    const rest = firstLine.replace(/^Watchdog:\s*/, '').replace(THREAD_LINK, '').replace(/^\s+/, '')
    return {
      kind: 'watchdog',
      threadId: m?.[2],
      threadTitle: m?.[1],
      summary: rest || 'stalled',
      body: trimmed,
    }
  }

  // "Started [B](thread:123) (id 123) from the queue..."
  if (/^Started \[[^\]]+\]\(thread:[^)]+\).*from the queue/.test(firstLine)) {
    const m = THREAD_LINK.exec(firstLine)
    return {
      kind: 'queued',
      threadId: m?.[2],
      threadTitle: m?.[1],
      summary: 'started from queue',
      body: trimmed,
    }
  }

  // "On the board, the user answered [Save v3](thread:123): Keep v2 saves loadable?\n→ Wipe"
  if (firstLine.startsWith('On the board, the user answered ')) {
    const m = THREAD_LINK.exec(firstLine)
    const arrow = trimmed.split('\n').find((l) => l.trim().startsWith('→'))?.trim()
    return {
      kind: 'relay',
      threadId: m?.[2],
      threadTitle: m?.[1],
      summary: arrow ? `answered ${arrow}` : 'answered on the board',
      body: trimmed,
    }
  }

  return undefined
}

/**
 * Parse a sent message's text blocks as cross-thread chatter. Batched reports/notes separated by blank lines or `---`
 * are collapsed together if the message starts with a recognised chatter prefix.
 */
export function readChatter(blocks: readonly SentBlock[]): { items: ChatterItem[]; blocks: number[] } | undefined {
  const items: ChatterItem[] = []
  const claimed: number[] = []
  blocks.forEach((b, i) => {
    if (b.type !== 'text' || !b.text) return
    const parsed = parseOne(b.text)
    if (!parsed) return
    items.push(parsed)
    claimed.push(i)
  })
  return items.length ? { items, blocks: claimed } : undefined
}

function ChatterRow({ machine, item }: { machine: MachineEntry; item: ChatterItem }) {
  const [open, setOpen] = useState(false)
  const prefix = item.kind === 'watchdog' ? 'Watchdog' : item.kind === 'relay' ? 'Board' : item.kind === 'queued' ? 'Queue' : 'From'
  return (
    <div className={`staff-chatter${open ? ' is-open' : ''}`}>
      <button type="button" className="staff-chatter__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <CaretRightIcon size={12} className={`staff-chatter__chev${open ? ' is-open' : ''}`} aria-hidden />
        <span className="staff-chatter__prefix">{prefix}</span>
        {item.threadId ? (
          <span className="staff-chatter__ref" onClick={(e) => e.stopPropagation()}>
            <ThreadRef machine={machine.id} id={item.threadId}>{item.threadTitle}</ThreadRef>
          </span>
        ) : null}
        {item.summary ? <span className="staff-chatter__sep">·</span> : null}
        {item.summary ? <span className="staff-chatter__summary">{item.summary}</span> : null}
      </button>
      {open && (
        <div className="staff-chatter__body">
          <Markdown text={item.body} compact />
        </div>
      )}
    </div>
  )
}

export function ChatterList({ machine, items }: { machine: MachineEntry; thread: ThreadInfo; items: ChatterItem[] }) {
  return (
    <div className="staff-chatter-list">
      {items.map((item, i) => <ChatterRow key={i} machine={machine} item={item} />)}
    </div>
  )
}

export const chatterSentWith: SentWith<ChatterItem> = {
  read: readChatter,
  component: ChatterList,
}

export const CHATTER_CSS = `
  .staff-chatter-list { display: block; width: 100%; max-width: 100%; min-width: 0; margin-top: -6px; white-space: normal; text-align: left; }
  .staff-chatter { font-size: var(--superego-text-sm); line-height: 1.45; color: var(--superego-muted); max-width: 100%; min-width: 0; }
  .staff-chatter + .staff-chatter { margin-top: 4px; }
  .staff-chatter__head { all: unset; box-sizing: border-box; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; overflow-wrap: anywhere; width: 100%; max-width: 100%; cursor: pointer; text-align: left; }
  .staff-chatter__head:hover .staff-chatter__chev, .staff-chatter__head:hover .staff-chatter__summary { color: var(--superego-text); }
  .staff-chatter__chev { display: inline-block; vertical-align: -2px; margin-right: 5px; color: var(--superego-faint); transition: transform .15s ease, color .15s ease; }
  .staff-chatter__chev.is-open { transform: rotate(90deg); }
  .staff-chatter__prefix { color: var(--superego-faint); margin-right: 5px; }
  .staff-chatter__ref { display: inline; }
  .staff-chatter__ref .thread-ref { vertical-align: baseline; }
  .staff-chatter__ref .thread-ref__title { max-width: 28ch; }
  .staff-chatter__sep { color: var(--superego-faint); margin: 0 5px; }
  .staff-chatter__summary { color: var(--superego-muted); transition: color .15s ease; }
  .staff-chatter__body { margin: 6px 0 2px 17px; padding: 4px 0 4px 10px; border-left: 2px solid var(--superego-line); color: var(--superego-text); overflow-wrap: anywhere; text-align: left; }
  .staff-chatter__body .md { line-height: 1.45; }
`
