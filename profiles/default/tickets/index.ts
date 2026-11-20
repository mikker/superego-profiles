// A folder's `.tickets`, found and read: every ticket in memory, read again (only the files that changed) when the
// folder changes, as the daemon's watcher says.
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { countOf, parseTicket } from './tickets.ts'
import type { Counts, Ticket } from './shared.ts'

export const TICKETS_DIR = '.tickets'

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false)
const exists = (path: string) => stat(path).then(() => true, () => false)

/**
 * The `.tickets` folder for `folder`: its own, else the nearest above it, stopping at the repository's root (the first
 * folder with `.git`, a worktree's file included, so a worktree reads its own checkout's tickets). Undefined if none.
 */
export async function findTicketsDir(folder: string): Promise<string | undefined> {
  for (let dir = folder; ; dir = dirname(dir)) {
    const candidate = join(dir, TICKETS_DIR)
    if (await isDir(candidate)) return candidate
    if (dirname(dir) === dir || await exists(join(dir, '.git'))) return undefined
  }
}

type FileMark = { mtime: number; size: number; id: string }

/** Every ticket in a `.tickets` folder, by id. `refresh()` reads it again, parsing only files that changed. */
export class TicketIndex {
  readonly byId = new Map<string, Ticket>()
  private files = new Map<string, FileMark>()
  /** Bumped by each refresh that changed something. */
  version = 0
  private running: Promise<boolean> | undefined
  private again = false

  readonly dir: string
  constructor(dir: string) { this.dir = dir }

  get counts(): Counts { return countOf(this.byId.values()) }

  /**
   * Read the folder again; true if any ticket changed. Calls while one runs share it, and one more read follows, so a
   * change made during a read isn't missed.
   */
  refresh(): Promise<boolean> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      let changed = false
      do {
        this.again = false
        changed = (await this.read()) || changed
      } while (this.again)
      return changed
    })().finally(() => { this.running = undefined })
    return this.running
  }

  private async read(): Promise<boolean> {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    const seen = new Set(names)
    let changed = false
    for (const [name, mark] of this.files) {
      if (seen.has(name)) continue
      this.files.delete(name)
      if (this.byId.get(mark.id)?.file === name) this.byId.delete(mark.id)
      changed = true
    }
    await Promise.all(names.map(async (name) => {
      const path = join(this.dir, name)
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) return
      const before = this.files.get(name)
      if (before && before.mtime === info.mtimeMs && before.size === info.size) return
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) return
      const ticket = parseTicket(text, name, info.mtimeMs)
      if (before && before.id !== ticket.id && this.byId.get(before.id)?.file === name) this.byId.delete(before.id)
      this.files.set(name, { mtime: info.mtimeMs, size: info.size, id: ticket.id })
      this.byId.set(ticket.id, ticket)
      changed = true
    }))
    if (changed) this.version++
    return changed
  }
}

/**
 * Watch `dir` for changes, calling `onChange` once things settle (`debounce` ms after the last event), and `onGone`
 * if the watch fails (the folder was removed). Stops with `signal`, or the function it returns.
 */
export function watchDir(dir: string, { debounce, signal, onChange, onGone }: {
  debounce: number; signal: AbortSignal; onChange: () => void; onGone: () => void
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  const stop = () => { clearTimeout(timer); watcher?.close(); watcher = undefined }
  try {
    watcher = watch(dir, { persistent: false, signal }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => { if (!signal.aborted) onChange() }, debounce)
    })
    watcher.on('error', () => { stop(); if (!signal.aborted) onGone() })
  } catch {
    queueMicrotask(onGone)
  }
  signal.addEventListener('abort', stop, { once: true })
  return stop
}
