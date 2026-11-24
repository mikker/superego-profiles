// 10er work: the default profile plus 10er's production admin MCP server (`tener`, set up on the machine).
import { defineProfile } from 'superego'

export default defineProfile({
  extends: 'user:default',
  description: '10er work, with the 10er production admin MCP',
  prompt:
    'The tener tools act on production 10er (users, charges, refunds, billing runs). Read freely. Before anything that changes data (refunds, charges, deletes, updates), say exactly what it will do and ask the user first.',
  // Adds to default's sentry and paraframe: extends merges mcpServers.
  mcpServers: ['tener'],
})
