# Notes: where Superego's extension API limits the email client

Built without changing Superego. Each point is a concrete extension point that would make this client (and others
like it) better, with what the profile does meanwhile.

## Secrets

1. **A real secret store for settings.** `{ type: 'string', secret: true }` only masks the field in Settings. The value
   sits in plain text in `~/.superego/settings.json`, every settings snapshot sends it to every client, and
   `superego settings` prints it, so any thread's agent with a shell can read the Fastmail token (which can send mail).
   Proposed: `superego.secrets` in the daemon half (`get(key)`, `set` only from a consent action or Settings), values
   kept in the OS keychain or an encrypted file, never in snapshots or `settings` output (clients get "set" / "not
   set"), and listed under `about.secrets` so Ego and agents never read them. *Meanwhile:* a `secret`, `consent`
   setting (an agent can't set it, but can read it), or `FASTMAIL_API_TOKEN` in the daemon's environment.

## Running in the background

2. **Extensions that load without a thread.** A profile's daemon half sets up only once one of its threads takes a
   turn or a window lists one, so after a daemon restart there is no push, no poll and no unread count until then.
   Proposed: `defineProfile({ background: true })` (or a user-level extension list) to set a profile's daemon halves
   up when the daemon starts. *Meanwhile:* it connects when the profile loads.

3. **Notifications.** No way to tell the user that mail arrived (from whom, about what), or to act on it. Proposed:
   `superego.notify({ title, body, tag, open: { thread?, pane?: { kind, params } } })` from the daemon half, going
   through the app's existing notification path (desktop, browser, phone), with a click that opens the pane on the
   message. *Meanwhile:* nothing; the count in the header moves.

4. **An app-level badge.** Snailblaze puts `unread/total` on its Dock icon. A profile can only draw inside its own
   threads (`header`, `thread.badge`). Proposed: `superego.badge(count | string)` for the rail/Dock/favicon, or let a
   profile contribute a view to the `rail` (see 5). *Meanwhile:* the Inbox count in the email threads' header.

5. **Window-level places for a profile.** Profiles' views fit only thread places (`beside`, `pane`, `header`). Mail is
   an app of its own; it wants a `space` or `rail` button that opens it without first finding an email thread.
   Proposed: let a profile register `space`/`rail` views (perhaps behind the user's consent), drawn with a thread of
   that profile chosen or started on demand. *Meanwhile:* open a thread with the email profile and keep it pinned.

## Showing mail

6. **A sandboxed document component.** Rendering untrusted HTML safely is subtle, and every extension that shows
   email, web content or reports re-does it. This one uses `<iframe sandbox="allow-same-origin allow-popups
   allow-popups-to-escape-sandbox allow-modals" srcdoc>`: same-origin so the pane can run Snailblaze's fix-ups (dark
   mail detection, fit-to-width, reader mode) and hear keys, safe only because `allow-scripts` is absent; it inherits
   the window's CSP, and the message's own CSP narrows it. Proposed: `<SandboxedDocument html policy={{ images:
   'none' | 'remote', fonts }} onLink onKey run={(doc) => …} ref={{ print, scroll }} />` in `superego/ui`, on an opaque
   origin of its own (like the html block's `frame.html`) with a message channel for links, keys, size and the
   fix-ups, so extensions never need `allow-same-origin`.

7. **The window's resolved theme.** The pane reads `--superego-*` colours by probing computed styles to decide dark or
   light and to colour prose mail like the pane. And `prefers-color-scheme` inside a frame follows the system, not
   Superego's own appearance, so mail that does its own dark mode can disagree with the pane. Proposed: `useTheme()` →
   `{ appearance: 'light' | 'dark', colors }`, and a way to give a frame the window's colour scheme.

8. **Opening links through Superego.** Links in a message open in a new browser window (`target=_blank`, escaping the
   sandbox). They'd better go where the user's links go: the Browser pane beside the thread or the system browser, per
   the link handlers. Proposed: `openUrl(url, { beside })` exported from `superego/ui` for use outside a link handler,
   and `mailto:` handed to the profile's own handler (here: the composer).

9. **Shipping a font.** Snailblaze sets prose in iA Writer Quattro V. A profile can't ship a font file except as a
   `data:` URL in its CSS. Proposed: a profile's static assets (`superego.asset('fonts/x.woff2')` → a URL the window
   serves). *Meanwhile:* the system font.

## Moving bytes

10. **Downloads and uploads.** Attachments go through method results and action params as base64 JSON: fine for
    receipts and small files, wasteful for large ones, and a download on a remote machine's daemon must pass through
    the window to reach the user's computer. Proposed: `superego/ui` `download(machine, { method, params, name })`
    streaming over a channel into the browser's download, and an upload counterpart (a `File` to a daemon method as a
    stream). Quick Look / open-with on the user's computer would follow.

## Keys

11. **Pane-scoped, remappable shortcuts.** Snailblaze's single-key triage (and its user-defined hotkeys) is a
    `keydown` handler inside the pane, so the keys aren't in ⌘K, can't be remapped in Settings → Keys, and only work
    while focus is in the pane (or its message frame, whose keys the pane forwards). Proposed: window actions with
    `when: { pane: 'email', focused: true }` and plain-letter keys allowed in that scope, listed and remappable like
    other actions.

12. **Daemon actions' keys are machine-wide.** An action with `keys` in a profile's daemon half binds in every thread
    of the machine once the profile has loaded, not just the profile's own. *Meanwhile:* ⌘⇧E is a window action of the
    profile's UI half, which is scoped to its threads.

## Asking the user

13. **A confirmation primitive.** Holding the agent's send until the user says yes took a scoped value, `status()`
    (blocked, `question`), a `composer.above` card, a resolver map, and a `consent` action so the agent can't answer
    for the user. Proposed: `await superego.confirm(thread, { title, body (Markdown), fields, actions: [...] })` in the
    daemon half, drawn by the app, consent-guarded, surviving reloads; "don't ask again in this thread" as a built-in
    choice.

## Settings

14. **List settings.** Blocked senders, the remote-content allowlist and the triage mailboxes are lists, held as
    comma-separated strings. Proposed: `{ type: 'list', of: 'string' }` with add/remove in Settings, and a
    `{ type: 'choice', options: () => … }` fed from live data (the account's mailboxes).

15. **Profile-scoped settings.** The Email section shows in Settings for the whole machine (once the profile has
    loaded), and settings are per machine, not per profile. Proposed: sections a profile owns, shown under the profile
    in Settings → Profiles, and allowed to differ per profile (two accounts, two profiles).

## Panes

16. **Pane state in params.** Which mailbox and message are showing is component state, lost when the window reloads
    or the pane is reopened. Proposed: `usePaneParams()` → `[params, setParams]` so a pane can keep its own deep link
    (and the agent sees what the user is looking at).

## Testing

17. **A DOM without a window.** In `extension test`, `DOMParser` and `document` exist only after `mountUi()`; a
    `// @vitest-environment happy-dom` comment isn't honoured, so the renderer's unit tests mount an empty window
    first. Proposed: honour the environment comment (or a `dom()` helper in `superego/testing`).

## Fastmail's own MCP server

Fastmail runs an MCP server at `https://api.fastmail.com/mcp` (OAuth, scope `https://www.fastmail.com/dev/mcp`). It
could give the agent tools through the `mcp-servers` extension with no code here, but not the pane (which needs JMAP
anyway), nor Snailblaze's workflows (block, newsletters, receipts, undo), nor a send that waits for the user. So this
profile talks JMAP directly, for both the pane and the agent, with one token. If the pane ever goes away, `mcpServers:
[{ fastmail: { url: 'https://api.fastmail.com/mcp', auth: { type: 'oauth' } } }]` in `profile.ts` (something like it) is the lighter path.
