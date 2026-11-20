// What tickets is, for both halves (spread into each), and the names and shapes they share.

/** A folder's tickets, as a live value scoped by the folder (a thread's `cwd`). */
export const STATE = 'tickets.state'
/** The pane: the folder's tickets, a list and the one picked. A pane kind of this id. */
export const PANE = 'tickets'

export const about = {
  name: 'tickets', version: '1.0.0', api: '^5', title: 'Tickets',
  panes: { [PANE]: "this folder's tk tickets (.tickets): a list to filter and search, and one ticket rendered. Params (all optional): { id } to show that ticket, { query } to search (words, type:bug, #tag, p1), { status: 'open' | 'closed' | 'all' }" },
}

/** What the list shows: open and in progress, closed, or every ticket (deleted and odd statuses too). */
export type StatusFilter = 'open' | 'closed' | 'all'
export const STATUS_FILTERS: StatusFilter[] = ['open', 'closed', 'all']

/** A ticket as read from its file. Anything the frontmatter says that isn't known here is kept in `extra`. */
export type Ticket = {
  id: string
  /** Its file's name in `.tickets` (`<id>.md`, usually). */
  file: string
  /** `open`, `in_progress`, `closed`, or whatever else the file says (`tombstone`, …), lowercased. */
  status: string
  /** `bug`, `feature`, `task`, `epic`, `chore`, or whatever else it says. */
  type: string
  /** 0 (highest) to 4. */
  priority: number
  title: string
  deps: string[]
  links: string[]
  tags: string[]
  parent?: string
  assignee?: string
  externalRef?: string
  /** As written (ISO 8601 from tk). */
  created?: string
  /** The file's modification time (ms): how recent it is. */
  mtime: number
  /** The Markdown after the title. */
  body: string
  extra: Record<string, string>
}

/** A ticket in a list: no body. `blocked`: it's open, and waits on a dep that's open too. */
export type TicketRow = Pick<Ticket, 'id' | 'title' | 'status' | 'type' | 'priority' | 'tags' | 'mtime' | 'created' | 'assignee' | 'parent'> & {
  blocked?: boolean
}

export type Counts = { open: number; in_progress: number; closed: number; all: number }

/** A folder's tickets as the window follows them. `dir` null: there's no `.tickets` from it up to the repository root. */
export type FolderState = {
  dir: string | null
  /** Bumped whenever a ticket changes: what the pane reads again on. */
  version: number
  counts?: Counts
  error?: string
}

export type ListResult = { dir: string | null; rows: TicketRow[]; total: number; counts: Counts }

/** Another ticket a ticket names (a dep, a link, its parent or a child): absent from the folder when `missing`. */
export type TicketRef = { id: string; title?: string; status?: string; missing?: boolean }

export type ShowResult = {
  ticket: Ticket
  deps: TicketRef[]
  links: TicketRef[]
  parent?: TicketRef
  children: TicketRef[]
}

export const NO_TICKETS: FolderState = { dir: null, version: 0 }
