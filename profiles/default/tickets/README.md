# tickets

A folder's [tk](https://github.com/wedow/ticket) tickets, read straight from `.tickets/*.md` and kept current as the
files change. Read-only: creating, starting, closing and editing tickets stays with the `tk` CLI.

- **Pane** (*Tickets*, in the pane menu): the list, with Open (open and in progress, the default), Closed and All, each
  with its count, and a search box. Each row has its status mark (a ring when open, half filled in progress, a dot
  closed, dashed for anything else, like `tombstone`), title, id, type, age and priority (P0 red, P1 orange). Pick one to
  see it: title, fields, its parent, deps, links and children as tickets to click through to, and its Markdown body.
  *File* opens the ticket's file in the editor. Wider than 720px, the list and the ticket sit side by side; narrower,
  one at a time with a way back (Esc, or *Tickets*).
- **Header pill**: the count of open and in-progress tickets (a quiet ring and a number), shown only where the folder
  has tickets and some are open. Click it for the pane. Right-click it to hide it, like any header view.
- **Agent tools**, only in threads whose folder has a `.tickets`: `tickets_search` (words and filters, one line per
  ticket) and `tickets_show` (one ticket in full, with what it names). And one line in the prompt: tickets live in
  `.tickets`, and changing them goes through `tk`.

## Search

Words match the id, title, tags, type, assignee and body; all of them must match. Matches on the id come first, then on
the title, then elsewhere. Filters can be written in the box: `type:bug`, `#ui` or `tag:ui`, `p1` or `p:1`,
`assignee:mikkel`, `parent:ab-12`, `status:in_progress`.

Lists sort by priority (0 first), then by the file's modification time, newest first. Closed alone sorts by
modification time only, so the recently closed come first (as `tk closed` does).

## Where the tickets are

The `.tickets` in the thread's folder, else the nearest above it, stopping at the repository root: the first folder
with `.git` (a directory, or a worktree's file). So a worktree reads its own checkout's tickets, not the main
checkout's. (tk itself walks on up to `/`.) A folder without one shows how to start (`tk create`); one made later is found
as the window comes back to the front, as a thread starts, or on the agent's next turn.

## Live

The daemon reads every ticket once (Tuna's 900 take about 0.2s), keeps them in memory, and watches the folder
(`fs.watch`). A change is read 150ms after the folder goes quiet, re-reading only files whose size or modification time
changed (a few ms). Each folder's counts and a version are a live value (`tickets.state`, scoped by folder); the pane
reads lists and tickets again whenever the version moves. Nothing polls.

## Reading the files

The frontmatter is parsed by hand, forgivingly: CRLF and a BOM, quoted values, lists as `[a, b]`, as `- a` lines or as a
bare `a, b`, priorities like `P1` or out of range (clamped to 0–4; unreadable is 2), statuses lowercased (`In-Progress`
reads `in_progress`), and fields it doesn't know kept and shown. No frontmatter, or one never closed: it's all body,
and the file name is the id. The title is the first `# ` heading if only blank lines come before it, else a `title:`
field, else the id. A `status:` in the body is the body's.

## Actions and methods

| | |
|---|---|
| `tickets.open` | open the pane (⌘K: *Show tickets*), or bring the thread's tickets pane to the front. `--id`, `--query`, `--status` show that ticket, search or status in it: `superego do tickets.open --thread <id> --id ab-12` |
| `tickets.state` | method: a folder's `{ dir, version, counts }`, looking for its `.tickets` again |
| `tickets.list` | method: `{ folder, status?, query?, limit? }` → `{ rows, total, counts }` |
| `tickets.show` | method: `{ folder, id }` (an id or a unique part of one) → the ticket, its deps, links, parent and children |

The pane takes the same params (`{ id, query, status }`), so the agent can open it on a ticket or a search with
`pane_open`.

## Writing, later

Writes go through `tk`, never by editing files here: an action per verb (`tickets.start`, `tickets.close`,
`tickets.reopen`, `tickets.note`, `tickets.create`), each running `tk` with `spawnGroup` in the folder above `.tickets`
(or with `TICKETS_DIR` set), its errors passed on as tk words them. Nothing else needs to change: the watcher sees tk's
write and every pane, pill and count follows. In the pane they'd be a status menu on the Status field, a note box under
the body, and a *New ticket* button by the search box.

## Files

`daemon.ts` (finding, watching, methods, the action, the agent's tools), `index.ts` (finding `.tickets`, the in-memory
index, the watcher), `tickets.ts` (parsing, filtering, sorting, searching, the agent's text; no I/O), `ui.tsx` (pane,
pill), `shared.ts`. Tests: `tickets.test.ts` (parsing, search, the folder, the daemon, the watch, the tools) and
`ui.test.tsx` (the pane, the pill, and the profiles serving its UI). Run them with `superego extension test tickets
--user`.

The `chief-of-staff` profile has tickets too: it lists `../default/tickets/daemon.ts` (one set-up,
shared) and `./tickets/ui.tsx` through `chief-of-staff/tickets`, a symlink to this folder, since the window loads a
profile's UI only from inside its own folder.
