// image-compression: the images each request to the model carries, re-encoded smaller (a screenshot's PNG as a JPEG)
// when they're larger than the setting says, so more of them fit what a provider takes (GitHub Copilot's few MB) before
// any is left out. Only what's sent changes: the thread keeps the originals. Off unless turned on, in Settings → Image
// compression.
//
// The core already fits every image to the model's own limits (2000 px a side, 4.5 MB); this asks for less, with the
// core's own fitting (`superego.images.fit`), before the core's (`hook(GenerationTask, { beforeRequest })`). Each image
// is encoded once at each size, and kept for the next request.
//
// Needs extension API 5.12, but asks for ^5 and looks for what it uses as it starts: a Superego without them (another
// machine not updated yet) is told in its log, and the profile it's in still loads.
import { createHash } from 'node:crypto'
import * as sdk from 'superego'

const { defineDaemonExtension, defineExtension, hook } = sdk
const GenerationTask = (sdk as { GenerationTask?: typeof sdk.GenerationTask }).GenerationTask

export const SETTINGS = { on: 'image-compression.on', over: 'image-compression.over' } as const
/** Larger than this (KB of base64), an image is compressed to this size. */
export const OVER_KB = 300
/** How much of the compressed images is kept for the next request. */
const CACHE_BYTES = 64 * 1024 * 1024

type Image = { type: 'image'; data: string; mimeType: string }
type Text = { type: 'text'; text: string }
type Fitted = Awaited<ReturnType<sdk.DaemonApi['images']['fit']>>

export default defineDaemonExtension({
  name: 'image-compression', version: '1.0.0', api: '^5', title: 'Image compression',
  description: 'Send the model smaller copies of large images (a screenshot as a JPEG), keeping the originals in the thread.',
  setup(superego) {
    if (!GenerationTask || !(superego as Partial<sdk.DaemonApi>).images) {
      console.error('image-compression: this Superego has no request hooks or image fitting (extension API 5.12): it does nothing here until it is updated.')
      return
    }
    superego.settings.register({
      id: 'image-compression', title: 'Image compression',
      description: 'Images the model is sent, as smaller copies. The thread keeps the originals.',
      settings: [
        { key: SETTINGS.on, title: 'Compress large images', description: 'A screenshot goes as a JPEG: smaller, a little softer.', default: false, type: { type: 'boolean' } },
        { key: SETTINGS.over, title: 'Larger than (KB)', description: 'Images over this are made this small or smaller.', default: OVER_KB, type: { type: 'number', min: 50, max: 4000, step: 50 } },
      ],
    })

    /** Compressed copies by the original's hash and the size asked for: the newest kept, up to CACHE_BYTES. */
    const cache = new Map<string, Promise<Fitted>>()
    const sizes = new Map<string, number>()
    let cached = 0
    function compressed(image: Image, maxBytes: number): Promise<Fitted> {
      const key = `${createHash('sha256').update(image.data).digest('hex').slice(0, 32)}:${maxBytes}`
      const was = cache.get(key)
      if (was) { cache.delete(key); cache.set(key, was); return was }
      const fitting = superego.images.fit({ data: image.data, mimeType: image.mimeType }, { maxBytes }).then((fitted) => {
        if (!fitted) console.error(`image-compression: an image (${Math.round(image.data.length / 1024)} KB of ${image.mimeType}) couldn't be made ${Math.round(maxBytes / 1024)} KB or smaller: it goes as it is.`)
        sizes.set(key, fitted?.data.length ?? 0)
        cached += fitted?.data.length ?? 0
        for (const [old] of cache) {
          if (cached <= CACHE_BYTES || old === key) break
          cache.delete(old)
          cached -= sizes.get(old) ?? 0
          sizes.delete(old)
        }
        return fitted
      }, (error: unknown) => {
        console.error('image-compression: compressing an image failed, so it goes as it is:', error)
        cache.delete(key)
        return undefined
      })
      cache.set(key, fitting)
      return fitting
    }

    /** A message's blocks with each image over `maxBytes` compressed (a line saying so when it was scaled down too). */
    async function smaller(content: (Image | Text)[], maxBytes: number) {
      let changed = false
      const out: (Image | Text)[] = []
      for (const block of content) {
        if (block.type !== 'image' || block.data.length <= maxBytes) { out.push(block); continue }
        const fitted = await compressed(block, maxBytes)
        if (!fitted) { out.push(block); continue }
        changed = true
        out.push({ type: 'image', data: fitted.data, mimeType: fitted.mimeType })
        const { from, to } = fitted.resized ?? {}
        if (from && to) out.push({ type: 'text', text: `[image scaled from ${from.width}×${from.height} to ${to.width}×${to.height} to send it smaller]` })
      }
      return changed ? out : undefined
    }

    superego.agent(defineExtension({
      name: 'image-compression',
      hooks: [hook(GenerationTask, {
        async beforeRequest({ messages }) {
          if (superego.settings.get<boolean>(SETTINGS.on) !== true) return undefined
          const maxBytes = (superego.settings.get<number>(SETTINGS.over) ?? OVER_KB) * 1024
          let changed = false
          const sent = await Promise.all(messages.map(async (message) => {
            if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string') return message
            const content = await smaller(message.content as (Image | Text)[], maxBytes)
            if (!content) return message
            changed = true
            return { ...message, content } as typeof message
          }))
          return changed ? { messages: sent } : undefined
        },
      })],
    }))
  },
})
