import { defineProfile } from 'superego'

export default defineProfile({
  ui: ['./tickets/ui.tsx'],
  // run: a folder's dev command (.superego/run.json), as a process of Superego's bundled Processes (⌃R).
  extensions: ['./run/daemon.ts', './tickets/daemon.ts', './image-compression/daemon.ts'],
  description: 'default',
  mcpServers: ['sentry', 'paraframe'],
})
