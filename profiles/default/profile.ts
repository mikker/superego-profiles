import { defineProfile } from 'superego'

export default defineProfile({
  ui: ['./run/ui.tsx', './tickets/ui.tsx'],
  extensions: ['./run/daemon.ts', './tickets/daemon.ts', './image-compression/daemon.ts'],
  description: 'default',
  mcpServers: ['sentry', 'paraframe'],
})
