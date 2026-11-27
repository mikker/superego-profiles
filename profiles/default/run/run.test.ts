// run against a real daemon, with a stand-in for Superego's Processes (what it's asked to do, recorded): the config
// read, a folder's .superego/run.json defined as its `run` process (idle until ⌃R), started by run.restart, kept in
// step with the file, the agent pointed at it, and a broken or missing config said.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineAction, defineDaemonExtension, obj, str, type DaemonExtension, type Json } from 'superego'
import { say, testDaemon, type TestDaemon } from 'superego/testing'
import { commandLine, findConfig, parseConfig } from './config.ts'
import run from './daemon.ts'

type Process = { id: string; owner: { folder: string }; name: string; command: string; state: string; run: number; [key: string]: unknown }

/** Processes as run sees it: definitions kept by owner and name, started and stopped as asked. */
function standIn(): { extension: DaemonExtension; asked: string[] } {
  const asked: string[] = []
  const records = new Map<string, Process>()
  const key = (owner: { folder: string }, name: string) => `${owner.folder}\0${name}`
  const find = ({ owner, name, id }: { owner?: { folder: string }; name?: string; id?: string }) => {
    const found = id ? [...records.values()].find((p) => p.id === id) : records.get(key(owner!, name!))
    if (!found) throw new Error('no such process')
    return found
  }
  const extension = defineDaemonExtension({
    name: 'processes', version: '1.0.0', api: '^5', title: 'Processes',
    setup(superego) {
      // Without a schema: whatever run passes, as it passes it.
      const act = <P>(id: string, run: (params: P) => unknown) =>
        superego.action(defineAction({ id, title: id, run: async (params) => { asked.push(id); return run(params as P) } }))
      act<Process>('processes.define', (spec) => {
        const known = records.get(key(spec.owner, spec.name))
        const record = { ...known, ...spec, id: known?.id ?? `p_${records.size}`, state: known?.state ?? 'idle', run: known?.run ?? 0 }
        records.set(key(spec.owner, spec.name), record)
        return record
      })
      type Target = Parameters<typeof find>[0]
      act<Target>('processes.restart', (p) => Object.assign(find(p), { state: 'running', run: find(p).run + 1 }))
      act<Target>('processes.stop', (p) => Object.assign(find(p), { state: 'exited' }))
      act<Target>('processes.remove', (p) => { records.delete(key(find(p).owner, find(p).name)); return null })
      superego.method('processes.list', async ({ folder }: { folder: string }) => [...records.values()].filter((p) => p.owner.folder === folder) as Json,
        { params: obj({ folder: str() }) })
    },
  })
  return { extension, asked }
}

let daemon: TestDaemon | undefined
const folders: string[] = []
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

async function folderWith(config: unknown): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'run-test-'))
  folders.push(folder)
  if (config !== undefined) {
    await mkdir(join(folder, '.superego'), { recursive: true })
    await writeFile(join(folder, '.superego', 'run.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return folder
}
const runOf = async (d: TestDaemon, folder: string) => (await d.call<Process[]>('processes.list', { folder })).find((p) => p.name === 'run')

describe('config', () => {
  it('reads commands as arrays or strings, with ready, grace and env', () => {
    expect(parseConfig('{"command":["just","run"],"ready":"STATUS:READY","grace":2}')).toEqual({ command: 'just run', ready: 'STATUS:READY', grace: 2000, env: {} })
    expect(parseConfig('{"command":"npm run dev -- --port 3000","env":{"PORT":3000,"X":"y"}}'))
      .toEqual({ command: 'npm run dev -- --port 3000', ready: undefined, grace: 5000, env: { PORT: '3000', X: 'y' } })
    expect(commandLine(['echo', "it's", 'a b', '--x=1'])).toBe(`echo 'it'\\''s' 'a b' --x=1`)
  })

  it('says what is wrong', () => {
    expect(() => parseConfig('{')).toThrow(/isn't JSON/)
    expect(() => parseConfig('[]')).toThrow(/object/)
    expect(() => parseConfig('{"command":[]}')).toThrow(/command/)
    expect(() => parseConfig('{"command":"x","grace":"soon"}')).toThrow(/grace/)
    expect(() => parseConfig('{"command":"x","env":{"A":{}}}')).toThrow(/env.A/)
  })

  it('finds the nearest config up to the repository root', async () => {
    const root = await folderWith({ command: 'echo hi' })
    const deep = join(root, 'a', 'b')
    await mkdir(deep, { recursive: true })
    expect((await findConfig(deep))?.dir).toBe(root)
    await mkdir(join(root, 'a', '.git'))
    expect(await findConfig(deep)).toBeUndefined()
    await writeFile(join(root, '.superego', 'run.json'), '{"command": 3}')
    await expect(findConfig(root)).rejects.toThrow(/run.json "command"/)
  })
})

describe('run', () => {
  it("defines the folder's dev command, starts it with run.restart, and keeps it in step with the file", async () => {
    const folder = await folderWith({ command: 'npm run dev', ready: 'ready in' })
    const processes = standIn()
    daemon = await testDaemon({ extensions: [processes.extension, run], model: [say('Noted.')] })
    const thread = await daemon.thread(undefined, { cwd: folder })
    await daemon.until(async () => (await runOf(daemon!, folder))?.state === 'idle', 'defined, idle')
    expect(await runOf(daemon, folder)).toMatchObject({ owner: { folder }, cwd: folder, command: 'npm run dev', ready: 'ready in', keep: true, notify: 'failure', restart: 'never' })

    expect(await daemon.dispatch('run.restart', { thread: thread.id })).toMatchObject({ state: 'running', run: 1 })
    await daemon.send(thread, 'Is the server up?')
    expect(await daemon.transcript(thread)).toContain("This folder's dev command is the process named `run`")

    // The file changed: its definition put again, once.
    await writeFile(join(folder, '.superego', 'run.json'), JSON.stringify({ command: 'echo changed' }))
    await daemon.until(async () => (await runOf(daemon!, folder))?.command === 'echo changed', 'the new command defined')
    expect(processes.asked.filter((a) => a === 'processes.define')).toHaveLength(2)
    await daemon.dispatch('run.stop', { thread: thread.id })
    expect((await runOf(daemon, folder))?.state).toBe('exited')
  })

  it('loads with this profile', async () => {
    const folder = await folderWith({ command: 'npm run dev' })
    daemon = await testDaemon({ profile: new URL('..', import.meta.url).pathname, extensions: [standIn().extension] })
    await daemon.thread(undefined, { cwd: folder })   // loads the profile
    await daemon.until(async () => (await runOf(daemon!, folder))?.command === 'npm run dev', 'defined')
  })

  it('says how to add a config where there is none', async () => {
    const folder = await folderWith(undefined)
    daemon = await testDaemon({ extensions: [standIn().extension, run] })
    const thread = await daemon.thread(undefined, { cwd: folder })
    await expect(daemon.dispatch('run.restart', { thread: thread.id })).rejects.toThrow(/No run config for .*Add \.superego\/run\.json/)
    expect(await runOf(daemon, folder)).toBeUndefined()
  })

  it('says a broken run.json in the thread working there', async () => {
    const folder = await folderWith('{"command": ')
    daemon = await testDaemon({ extensions: [standIn().extension, run] })
    const thread = await daemon.thread(undefined, { cwd: folder })
    await daemon.until(async () => (await daemon!.transcript(thread)).includes('The dev command’s config is broken'), 'said')
    expect(await daemon.transcript(thread)).toMatch(/run\.json isn't JSON/)
  })
})
