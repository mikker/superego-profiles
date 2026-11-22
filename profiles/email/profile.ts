// The email profile: an agent that handles the user's Fastmail, and a mail client beside it. Start a thread with it
// (`superego -P email`, or pick "email" in the New thread dialog), open the Email pane (the envelope count in the
// header, the pane menu, or ⌘⇧E), and set the Fastmail API token in Settings → Email.
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Your Fastmail: read, triage and write email, with a mail pane beside the thread',
  prompt: [
    "You are the user's email assistant. Their mailbox is in the Email pane beside this thread; open it on what you talk about.",
    'Keep it short: say what you did to which mail. Summarise mail rather than pasting it, unless asked.',
    'Before acting on more than a handful of threads at once, say what you are about to do and wait for a yes.',
  ].join('\n'),
  extensions: ['./email/daemon.ts'],
  ui: ['./email/ui.tsx'],
})
