// image-compression, tested as it runs: a screenshot-sized PNG attached to a message, in a real daemon, and what the
// model is sent of it (seen by a spy hooked after it): as it is while the setting is off, a smaller copy once it's on,
// the transcript keeping the original. Run with `superego extension test image-compression --user`.
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { testDaemon, type TestDaemon } from 'superego/testing'

const here = new URL('.', import.meta.url).pathname
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

/** A `width`×`height` PNG of a gradient with a little noise: what a screenshot's photo or shading looks like to deflate. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    out.set(data, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  let seed = 7
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 16) % 24 }
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set([(x * 255 / width + noise()) & 255, (y * 255 / height + noise()) & 255, 128 + noise()], 1 + x * 3)
    return row
  })
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', new Uint8Array())])
}

// After image-compression in the profile, so it sees what's sent: each image's type and size, by request.
const SPY = `import { defineDaemonExtension, defineExtension, GenerationTask, hook } from 'superego'
const seen = []
export default defineDaemonExtension({
  name: 'spy', version: '1.0.0', api: '^5.12',
  setup(superego) {
    superego.method('spy.seen', () => seen)
    superego.agent(defineExtension({ name: 'spy', hooks: [hook(GenerationTask, { beforeRequest({ messages }) {
      seen.push(messages.flatMap((m) => typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'image').map((b) => ({ mimeType: b.mimeType, kb: Math.round(b.data.length / 1024) }))))
      return undefined
    } })] }))
  },
})
`
const profile = {
  'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./image-compression/daemon.ts', './spy.ts'] })\n`,
  'image-compression/daemon.ts': readFileSync(`${here}daemon.ts`, 'utf8'),
  'spy.ts': SPY,
}

it('sends large images as they are while off, and as smaller copies once on, keeping the originals', async () => {
  daemon = await testDaemon({ profile, model: 'echo' })
  const bytes = png(1200, 800)
  const shot = bytes.toString('base64')
  expect(shot.length).toBeGreaterThan(1024 * 1024)
  const attachments = [{ name: 'shot.png', mimeType: 'image/png', data: shot }]
  const thread = await daemon.thread()
  await daemon.call('action.run', { id: 'thread.send', params: { thread: thread.id, text: 'look', attachments } })
  await daemon.idle(thread)
  expect(await daemon.call('spy.seen')).toEqual([[{ mimeType: 'image/png', kb: Math.round(shot.length / 1024) }]])

  await daemon.call('action.run', { id: 'settings.set', params: { key: 'image-compression.on', value: true } })
  await daemon.send(thread, 'and now?')
  const [, after] = await daemon.call<{ mimeType: string; kb: number }[][]>('spy.seen')
  expect(after).toHaveLength(1)
  expect(after![0]!.mimeType).toBe('image/jpeg')
  expect(after![0]!.kb).toBeLessThanOrEqual(300)
  // The thread keeps what was attached, as it was.
  expect(await daemon.transcript(thread)).toContain(`"mimeType":"image/png","bytes":${bytes.length}`)
})
