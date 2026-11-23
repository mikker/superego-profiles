# email

Your Fastmail inside Superego: a mail pane beside the thread, and an agent that can read, triage and write email for
you. A port of [Snailblaze](https://github.com/mikker/snailblaze)'s behaviour and its way of rendering mail, over
Fastmail's JMAP API.

## Set up

1. Make a Fastmail API token: fastmail.com → Settings → Privacy & Security → Manage API tokens → New API token. Give it
   **Email** (read and write), **Submission** (to send) and **Contacts** (for the Newsletters workflow).
2. In Superego: **Settings → Email → Fastmail API token**, or `superego secrets set email.token` in your own terminal.
   It goes into Superego's secret store (the macOS Keychain; on Linux the Secret Service, else an encrypted file in
   `~/.superego`). No client, agent or `superego settings` ever sees it, and only you can set it.
   `FASTMAIL_API_TOKEN` in the daemon's environment works too. Needs Superego with extension API 5.8.
3. Start a thread with the **email** profile (New thread → profile *email*, or `superego -P email`), and open the
   **Email** pane: the envelope count in the thread's header, the pane menu, or ⌘⇧E.

The daemon half connects as soon as the profile loads (a thread of it takes a turn, or the window lists one), then
listens to Fastmail's push (its JMAP event source) and polls every few minutes on top.

## The pane

Mailboxes (your triage mailboxes on top; keys 1–9 go to them), the mailbox's threads newest first, and the message.
Threads are grouped by conversation; ignored (flagged) threads are hidden from triage, as in Snailblaze, with a link to
show them. Triage starts at the oldest thread and moves towards the newest.

| Key | Does |
|---|---|
| `k` / `j` (↑ / ↓) | next (newer) / previous (older) thread |
| `a` `s` `t` | archive, junk, trash the thread |
| `i` | ignore: flag it and hide it from triage |
| `x` | block the sender and junk the thread (More menu: block their domain, unblock) |
| `n` | file a newsletter: sender into the Newsletters contact group, thread into the Newsletters mailbox |
| `b` | file a receipt: download its attachments (or print it when it has none), then archive |
| `u` | undo the last action (the history is kept across restarts, in `~/.superego/extensions/email/`) |
| `r` | reply (Reply all and Forward are buttons) |
| `⇧R` | reader mode |
| space / ⇧space, ⌃D / ⌃U | scroll the message a page / half a page |
| ⌃R | refresh |
| `c` | new message |
| `/` | search (`from:`, `to:`, `subject:`, `is:unread`, `is:flagged`, `has:attachment`, `after:`, `before:`) |

More: move to any mailbox, mark read/unread, flag, mail from this sender, copy the address. The message shown is
marked read. "You already replied", the other mailboxes it's in (Fastmail labels), the whole conversation, attachments
to download, and remote content blocked until you load it once or always allow the sender or their domain.

**Composer**: To, Cc, Bcc, Subject, a body in plain text or Markdown (with a preview), attachments (pick or drop
files). It saves to Drafts as you type. A reply starts quoted (Snailblaze's "On …, … wrote:"), threads onto the
original, and sends with **Send & Archive** (⌘↩) or just **Send**. Drafts open in the composer from the Drafts mailbox.

## How mail is rendered

As Snailblaze renders it (`email/render.ts`): each message becomes a complete, inert document in a sandboxed frame,
with a Content Security Policy first (no scripts, forms, frames, or remote anything until you allow it), then
Snailblaze's stylesheet. HTML that brings its own design keeps it, on light "paper", inverted with its hue kept in dark
mode (pictures inverted back) unless it supports dark mode itself; mail that paints its own dark page is left alone;
wide fixed-width mail is zoomed to fit. Plain text and unstyled HTML become prose in the window's own colours, with
nested `>` quotes as coloured bars and links found. `cid:` inline images and image parts are fetched and inlined.
Reader mode keeps only the main content. Links open in a new window, outside the frame.

## The agent's tools

`email_mailboxes`, `email_list`, `email_search`, `email_read`, `email_move` (archive, junk, trash, ignore, any
mailbox), `email_mark`, `email_undo`, `email_block_sender`, `email_file_newsletter`, `email_file_receipt` (saves to the
receipts folder on the daemon's machine), `email_draft` (new, reply, reply all, forward; Markdown; attach files from the
thread's folder), `email_send`, `email_delete_draft`, `email_save_attachment`.

**Sending asks you.** `email_send` waits, with the thread marked as asking, until you answer the card over the
composer: *Send*, *Send, and don't ask again here* (this thread), or *Don't send*. Answering is a consent action, so
the agent can't answer it itself (from its shell or otherwise). Settings → Email → *Ask before the agent sends* turns
it off.

## Settings (Settings → Email)

Token, send-as address, triage mailboxes, refresh interval, blocked senders, remote-content allowlist, Newsletters
mailbox and contact group, receipts folder (for the agent), the send confirmation, and the JMAP session URL (any JMAP
server, not just Fastmail).

## Files

`email/daemon.ts` (settings, state, push, methods, actions, tools, the send confirmation), `email/jmap.ts` (the JMAP
client), `email/render.ts` (the message document), `email/markdown.ts` (Snailblaze's Markdown), `email/text.ts` (HTML as
text for the agent), `email/shared.ts`, `email/ui.tsx` (pane, header count, the confirmation card, tool rows). Tests run
against `email/fake-jmap.ts`, a small JMAP server on localhost: `superego extension test --user -P email`.

See [NOTES.md](NOTES.md) for where Superego's extension API limits this, and what would make it better.
