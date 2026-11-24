// Worker UI: collapses incoming messages from the chief-of-staff lead (`From [Lead](thread:...)`) into a compact
// expandable line in the worker's transcript.
import { defineUiExtension } from 'superego/ui'
import { CHATTER_CSS, chatterSentWith } from './chatter.tsx'

export default defineUiExtension({
  name: 'staff-worker',
  api: '^5',
  title: 'Chief of staff worker',
  setup(superego) {
    superego.composer.sentWith(chatterSentWith)
    superego.style(CHATTER_CSS)
  },
})
