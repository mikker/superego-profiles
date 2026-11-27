import { defineProfile } from 'superego'

export default defineProfile({
  // A folder's dev command (.superego/run.json) is Superego's built-in run, shown through Processes.
  ui: ['./tickets/ui.tsx'],
  extensions: ['./tickets/daemon.ts', './image-compression/daemon.ts'],
  description: 'default',
  mcpServers: ['sentry', 'paraframe'],
})
