// run, daemon half: each folder's dev command, from its `.superego/run.json` (or the `run.command` setting), defined as
// a process of Processes' that the folder owns (named `run`, `keep`: started again after a restart of the machine if
// it was running, `notify: 'failure'`: its death wakes the thread working there, the last active in the folder).
// Processes runs, shows, follows and stops it (archiving a folder's last thread stops it); Run keeps the definition in
// step with the file (looked at as a thread there starts or runs a turn, and as the file changes; a broken one said in
// that thread), ⌃R (`run.restart`), `run.stop` and `run.logs`, and tells the agent which process is the dev command.
// It needs Superego's bundled Processes extension on: without it, ⌃R and the rest say they can't.
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  defineAction, defineDaemonExtension, defineExtension, obj, opt, RpcError, section, str, type ThreadInfo,
} from 'superego'
import { DEFAULT_GRACE, findConfig, howToAdd, type FoundConfig } from './config.ts'
import { about, NAME } from './shared.ts'

/** The Processes pane, where its output shows. */
const PANE = 'processes'
type Known = { id: string; name?: string; state: string }

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.settings.register({
      id: 'run', title: 'Run', description: "Each folder's dev command, from its .superego/run.json.",
      settings: [{
        key: 'run.command', title: 'Default command', default: '', type: { type: 'string', placeholder: 'e.g. just run' },
        description: 'Run where a folder has no .superego/run.json. Empty: none.',
      }],
    })

    /** Its config: the folder's run.json, else the setting's command; none, undefined. Throws when the file is wrong. */
    async function configOf(folder: string): Promise<FoundConfig | undefined> {
      const found = await findConfig(folder)
      if (found) return found
      const command = String(superego.settings.get<string>('run.command') ?? '').trim()
      return command ? { command, grace: DEFAULT_GRACE, env: {}, path: 'settings: run.command', dir: folder } : undefined
    }

    const owner = (folder: string) => ({ folder })
    /** What each folder's definition was last put as, so an unchanged one isn't put again. */
    const defined = new Map<string, string>()
    /** The config file each folder's is from, watched for changes. */
    const watching = new Map<string, { path: string; watcher: FSWatcher }>()

    /** The folder's process, as Processes has it now. */
    const processOf = async (folder: string) => (await superego.call('processes.list', { folder }) as Known[]).find((p) => p.name === NAME)

    /** Put the folder's definition in step with its config: defined, changed, or gone (an idle one; a running one stays). */
    async function sync(folder: string): Promise<FoundConfig | undefined> {
      const config = await configOf(folder)
      follow(folder, config)
      if (!config) {
        if (defined.has(folder)) {
          defined.delete(folder)
          const known = await processOf(folder)
          if (known?.state === 'idle') await superego.dispatch('processes.remove', { id: known.id })
        }
        return undefined
      }
      const spec = {
        owner: owner(folder), name: NAME, command: config.command, cwd: config.dir, grace: config.grace, env: config.env,
        notify: 'failure', restart: 'never', keep: true, ...(config.ready ? { ready: config.ready } : {}),
      }
      const text = JSON.stringify(spec)
      if (defined.get(folder) !== text) {
        await superego.dispatch('processes.define', spec)
        defined.set(folder, text)
      }
      return config
    }
    /** What each folder's config was last found to be wrong with, as said in a thread there: said once, until it's fixed. */
    const broken = new Map<string, string>()
    /** Every folder looked at: a change of the default command may give any of them a dev command. */
    const looked = new Set<string>()
    /** Put it in step; a broken config said in the thread working there (`thread`, else the last active in the folder). */
    const resync = (folder: string, thread?: string) => void (looked.add(folder), sync(folder)).then(
      () => { broken.delete(folder) },
      async (error: Error) => {
        console.error(`run: ${folder}: ${error.message}`)
        if (broken.get(folder) === error.message) return
        broken.set(folder, error.message)
        const to = thread ?? (await superego.threads.list()).filter((t) => t.cwd === folder && !t.archived).sort((a, b) => b.activeAt - a.activeAt)[0]?.id
        if (!to) return
        const kept = defined.has(folder) ? ' Until it’s fixed, ⌃R runs the command it had before.' : ''
        await superego.threads.notice(to, { text: `The dev command’s config is broken: ${error.message}.${kept}` })
      },
    ).catch((error: Error) => console.error(`run: couldn't say ${folder}'s config is broken: ${error.message}`))

    /**
     * Watch the folder the config file is in, for that file: an edit puts the definition in step. Its folder, not the
     * file: an editor's save writes a new file in its place, which a watch of the old one doesn't follow.
     */
    function follow(folder: string, config: FoundConfig | undefined) {
      const path = config && !config.path.startsWith('settings:') ? config.path : undefined
      const now = watching.get(folder)
      if (now?.path === path) return
      now?.watcher.close()
      watching.delete(folder)
      if (!path || superego.signal.aborted) return
      const name = basename(path)
      try {
        const watcher = watch(dirname(path), { signal: superego.signal }, (_event, file) => { if (!file || file === name) resync(folder) })
        watcher.on('error', (error) => {
          console.error(`run: stopped watching ${path}: ${error.message}`)
          watcher.close()
          watching.delete(folder)
        })
        watching.set(folder, { path, watcher })
      } catch (error) {
        console.error(`run: can't watch ${path}: ${(error as Error).message}`)
      }
    }
    // The default command changed: every folder's that has none of its own may have changed with it.
    let fallback = superego.settings.get<string>('run.command')
    superego.settings.onChange(() => {
      const now = superego.settings.get<string>('run.command')
      if (now === fallback) return
      fallback = now
      for (const folder of looked) resync(folder)
    })

    // ── Actions: ⌃R, ⌘K, `superego do` ──────────────────────────────────────────────────────────────────────────────
    const target = obj({
      thread: opt(str({ description: 'a thread: its folder' })),
      folder: opt(str({ description: 'a folder, instead of a thread' })),
    })
    async function folderOf({ thread, folder }: { thread?: string; folder?: string }) {
      if (folder) return folder
      if (!thread) throw new RpcError('invalid', 'Say which thread (--thread) or folder (--folder).')
      return (await superego.threads.get(thread)).cwd
    }
    /** The folder's definition, put now (its config read again): refused, saying how to add one, when there's none. */
    async function ensure(folder: string) {
      const config = await sync(folder).catch((error: Error) => { throw new RpcError('invalid', error.message) })
      if (!config) throw new RpcError('not_found', howToAdd(folder), { hint: 'Add .superego/run.json, then restart.' })
    }

    superego.action(defineAction({
      id: 'run.restart', title: 'Restart the dev command', description: "Start this folder's dev command, or restart it if it runs.",
      expose: ['ui', 'cli'], thread: true, params: target, keys: 'ctrl+r',
      run: async (params) => {
        const folder = await folderOf(params)
        await ensure(folder)
        return superego.dispatch('processes.restart', { owner: owner(folder), name: NAME })
      },
    }))
    superego.action(defineAction({
      id: 'run.stop', title: 'Stop the dev command', description: "Stop this folder's dev command.",
      expose: ['ui', 'cli'], thread: true, params: target,
      run: async (params) => superego.dispatch('processes.stop', { owner: owner(await folderOf(params)), name: NAME }),
    }))
    superego.action(defineAction({
      id: 'run.logs', title: 'Show the dev command’s output', description: "Open the folder's dev command beside the thread, in Processes.",
      expose: ['ui', 'cli'], thread: true, params: obj({ thread: opt(str()) }),
      run: async ({ thread }) => {
        if (!thread) throw new RpcError('invalid', 'Say which thread (--thread).')
        const folder = await folderOf({ thread })
        await ensure(folder)
        const known = await processOf(folder)
        return superego.dispatch('pane.open', { thread, kind: PANE, ...(known ? { params: { id: known.id } } : {}) })
      },
    }))

    // ── The agent: which process is the dev command ─────────────────────────────────────────────────────────────
    superego.agent(defineExtension({
      name: 'run',
      sections: [section('run', async ({ conversationId }) => {
        const id = superego.threads.of(conversationId as never)
        if (!id) return undefined
        const { cwd } = await superego.threads.get(id)
        if (!defined.has(cwd)) return undefined
        return "This folder's dev command is the process named `run` (from .superego/run.json; the user starts it with ⌃R). "
          + "Use process_logs and process_restart on it (id `run`); don't start the server yourself."
      })],
    }))

    // ── Every folder in use, at setup and as threads start and run ──────────────────────────────────────────────
    const folders = (threads: ThreadInfo[]) => new Set(threads.filter((t) => !t.archived).map((t) => t.cwd))
    void superego.threads.list().then((threads) => { for (const folder of folders(threads)) resync(folder) },
      (error: Error) => console.error(`run: couldn't list threads: ${error.message}`))
    superego.thread({
      started(thread) { resync(thread.cwd, thread.id) },
      turnStart(thread) { resync(thread.cwd, thread.id) },
    })

    return () => { for (const { watcher } of watching.values()) watcher.close() }
  },
})
