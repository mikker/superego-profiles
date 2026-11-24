// staff in a real daemon (superego/testing's), on short timers:
// - watchdog + live activity over working lanes;
// - lane_start concurrency cap + queue draining (replacing raw thread_start);
// - lane_send single-slot held mailbox (coalescing/replacing/dropping notes while a lane is working, delivering one
//   message once idle);
// - reports with real git worktree branch changes, kept past archive until dismissed or cleared;
// - Direction B triage board (Action required, In flight, Ready to land, Landed, Answered, wave filter pills).
// `superego extension test --user -P chief-of-staff`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { blockErrors, type Block, type ThreadInfo } from 'superego'
import { callTool, mountUi, say, testDaemon, type TestDaemon, type TestWindow } from 'superego/testing'
import board from '../board.tsx'
import { readChatter } from '../chatter.tsx'
import type { StaffOptions } from '../staff.ts'
import { BOARD, PANE, type Board, type Details } from '../shared.ts'

const here = new URL('.', import.meta.url).pathname

/**
 * The profile as the real one, with staff on test timers (and `workerProfile: null` since testDaemon only hosts one
 * profile), plus stand-ins for worktrees and agent-ui. No thread-tools stand-in: staff owns its own lane_* tools.
 */
const source = (file: string) => readFileSync(join(here, '..', file), 'utf8')
const profile = (options: StaffOptions) => ({
  'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./staff.ts', './worktrees.ts', './agent-ui.ts'], ui: ['./board.tsx'] })\n`,
  'board.tsx': source('board.tsx'),
  'chatter.tsx': source('chatter.tsx'),
  'shared.ts': source('shared.ts'),
  'staff.ts': `import { staff } from ${JSON.stringify(join(here, '..', 'staff.ts'))}\nexport default staff(${JSON.stringify({ workerProfile: null, ...options })})\n`,
  'worktrees.ts': `export { worktrees as default } from ${JSON.stringify(join(here, 'stand-ins.ts'))}\n`,
  'agent-ui.ts': `export { agentUi as default } from ${JSON.stringify(join(here, 'stand-ins.ts'))}\n`,
})

let daemon: TestDaemon | undefined
let window: TestWindow | undefined
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  await window?.unmount()
  await daemon?.close()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  window = daemon = undefined
})

const up = async (options: StaffOptions, model: NonNullable<Parameters<typeof testDaemon>[0]>['model']) =>
  daemon = await testDaemon({ profileName: 'chief-of-staff', profile: profile(options), model })
const said = async (thread: string, text: string) => (await daemon!.transcript(thread)).split(text).length - 1
const childrenOf = async (lead: string) => (await daemon!.call<ThreadInfo[]>('thread.list', {})).filter((t) => t.parent === lead)

it('tracks live activity and tells the lead once when a working lane stalls', async () => {
  // The child sits in a 3s bash call: live activity shows immediately, stalled after 1s.
  await up({ tickMs: 100, stallMs: 1_000 }, [callTool('bash', { command: 'sleep 3' }), say('Noted.'), say('Smoke done.')])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  const smoke = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Smoke', prompt: 'Run the smoke' })
  await watched.until((b) => b.activity[smoke.id] === 'bash (`sleep 3`)', 'live activity on the board')
  await watched.until((b) => Boolean(b.stalled[smoke.id]), 'the stall on the board')
  expect(watched.value.stalled[smoke.id]).toMatchObject({ call: 'bash (`sleep 3`)' })
  const told = `Watchdog: [Smoke](thread:${smoke.id}) has made no progress for 1 min, in bash (\`sleep 3\`).`
  await daemon!.until(async () => (await said(lead.id, told)) > 0, 'the lead told')
  const once = await said(lead.id, told)

  // Done: off the stalled and activity lists, reported, and not told again.
  await daemon!.idle(smoke.id)
  await watched.until((b) => b.reports.length === 1 && !b.stalled[smoke.id] && !b.activity[smoke.id], 'its report')
  expect(watched.value.reports[0]).toMatchObject({ id: smoke.id, title: 'Smoke', outcome: 'done', answer: 'Smoke done.' })
  expect(await said(lead.id, 'Watchdog')).toBe(once)
}, 20_000)

it('queues lane_start beyond the cap, and starts the queued as a lane finishes', async () => {
  await up({ tickMs: 100, cap: 1 }, [
    callTool('lane_start', { prompt: 'Do A', title: 'A' }),
    // A's first turn holds the slot while B is requested.
    callTool('bash', { command: 'sleep 2' }),
    callTool('lane_start', { prompt: 'Do B', title: 'B' }),
    say('One started, one queued.'),
    say('A done.'),
    // B's first turn and the lead's turn on queue start, in either order.
    say('Ok.'), say('Ok.'),
  ])
  const lead = await daemon!.thread('Start A and B', { title: 'Lead' })
  const transcript = await daemon!.transcript(lead.id)
  expect(transcript).toContain('Started [A]')
  expect(transcript).toMatch(/Queued as queued-\w+ \(1 running\): it starts when a slot frees up, and you'll be told\./)
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.queued.map((q) => q.title).join() === 'B', 'B queued on the board')

  // A finishes and is archived: B starts, in the lead's folder, as its child; the lead is told.
  const [a] = await childrenOf(lead.id)
  await daemon!.idle(a!.id)
  await daemon!.dispatch('thread.archive', { thread: a!.id })
  await daemon!.until(async () => (await said(lead.id, 'from the queue.')) > 0, 'the lead told of B')
  const [b] = await childrenOf(lead.id)
  expect(b).toMatchObject({ title: 'B', cwd: lead.cwd })
  expect(await daemon!.transcript(lead.id)).toContain(`Started [B](thread:${b!.id}) (id ${b!.id}) from the queue.`)
  await watched.until((x) => x.queued.length === 0, 'the queue empty')
}, 20_000)

it('coalesces multiple lane_send calls to a working lane into one held note and delivers once on idle', async () => {
  await up({ tickMs: 100 }, [
    // Turn 1 (child): sleeps 2.5s in bash.
    callTool('bash', { command: 'sleep 2.5' }),
    // Turn 2 (lead): calls lane_send twice while child is busy.
    callTool('lane_send', { thread: '10', text: 'First note' }),
    callTool('lane_send', { thread: '10', text: 'Second note' }),
    say('Sent both.'),
    // Turn 3 (child): finishes first turn.
    say('First pass done.'),
    // Turn 4 (child): answers the single combined follow-up delivered by staff.
    say('Handled both at once.'),
  ])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  const child = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Ziplines', prompt: 'Start work' })
  await watched.until((b) => b.activity[child.id] === 'bash (`sleep 2.5`)', 'child working in bash')

  // While child is working, lead calls lane_send twice: held as 1 coalesced note on the board.
  await daemon!.send(lead.id, 'Nudge twice')
  await watched.until((b) => b.held[child.id]?.count === 2, 'two notes coalesced into one held note')
  expect(watched.value.held[child.id]!.text).toContain('First note')
  expect(watched.value.held[child.id]!.text).toContain('Second note')
  expect(await daemon!.transcript(lead.id)).toContain('Merged into the single held note (2 combined)')

  // Once child finishes its first turn, staff delivers the single combined note and clears the held slot.
  await watched.until((b) => !b.held[child.id], 'held note delivered and cleared')
  await daemon!.until(async () => (await daemon!.transcript(child.id)).includes('Handled both at once.'), 'child answered combined note', 10_000)
  expect(await said(child.id, 'From [Lead]')).toBe(1)
  expect(await daemon!.transcript(child.id)).toContain('First note')
  expect(await daemon!.transcript(child.id)).toContain('Second note')
}, 25_000)

it('lets the user drop a held note from the board before delivery', async () => {
  await up({ tickMs: 100 }, [
    callTool('bash', { command: 'sleep 2.5' }),
    callTool('lane_send', { thread: '10', text: 'Stale reminder' }),
    say('Held.'),
    say('Finished clean.'),
  ])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  const child = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Ziplines', prompt: 'Start slow' })
  await watched.until((b) => Boolean(b.activity[child.id]), 'child working')

  await daemon!.send(lead.id, 'Queue note')
  await watched.until((b) => b.held[child.id]?.count === 1, 'held note visible')

  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('1 note held'), 'held badge on the board')
  await pane.click('button[title="Drop held note (c)"]')
  await watched.until((b) => !b.held[child.id], 'held note dropped')

  await daemon!.idle(child.id)
  await new Promise((r) => setTimeout(r, 300))
  expect(await said(child.id, 'Stale reminder')).toBe(0)
}, 25_000)

it("reports a child with its branch's changes, keeps it past the archive, and drops it when dismissed on the board", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staff-repo-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'main')
  const tree = join(dir, 'lane')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a')
  git(repo, 'worktree', 'add', '-q', '-b', 'superego/lane', tree, 'HEAD')
  writeFileSync(join(tree, 'a.txt'), 'one\nTWO\nthree\n')
  writeFileSync(join(tree, 'b.txt'), 'b\n')
  git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'lane')

  await up({ tickMs: 100 }, [say('Did the lane.\nAll green.')])
  const lead = await daemon!.thread(undefined, { title: 'Lead', cwd: repo })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  const lane = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Lane', cwd: repo, profile: 'chief-of-staff', options: { worktrees: { path: tree, branch: 'superego/lane' } } })

  await watched.until((b) => b.changes[lane.id]?.added === 3, 'its changes')
  expect(watched.value.changes[lane.id]).toMatchObject({ added: 3, removed: 1 })
  expect(watched.value.reports).toEqual([])

  writeFileSync(join(repo, 'c.txt'), 'c\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'c')
  git(tree, 'rebase', '-q', 'main')
  git(repo, 'merge', '-q', '--ff-only', 'superego/lane')
  await daemon!.send(lane.id, 'Finish it')
  await watched.until((b) => b.reports.length === 1, 'its report')
  expect(watched.value.reports[0]).toMatchObject({
    id: lane.id, title: 'Lane', outcome: 'done', answer: 'Did the lane.\nAll green.', branch: 'superego/lane', merged: true,
    changes: { added: 3, removed: 1, files: [{ path: 'a.txt', added: 2, removed: 1 }, { path: 'b.txt', added: 1, removed: 0 }] },
  })

  await daemon!.dispatch('thread.archive', { thread: lane.id })
  await watched.until((b) => !b.changes[lane.id], 'its changes gone with it')
  expect(watched.value.reports).toHaveLength(1)
  expect(await daemon!.call<Details[]>('staff.details', { id: lead.id })).toEqual([{ id: lane.id, answer: null, merged: true }])

  // On the triage board, under Landed (unfolded since no active work); heading folds and unfolds on click.
  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('Did the lane.'), 'the report on the board')
  expect(pane.text()).toContain('Landed')
  expect(pane.text()).toContain('merged')
  await pane.click('[data-key="section:landed"]')
  await window.until(() => !pane.text().includes('Did the lane.'), 'Landed folded')
  await pane.click('[data-key="section:landed"]')
  await window.until(() => pane.text().includes('Did the lane.'), 'Landed unfolded')
  await pane.click('button[aria-label="Dismiss"]')
  await watched.until((b) => b.reports.length === 0, 'dismissed')
  await window.until(() => pane.text().includes('No threads started yet.'), 'the board empty')
  await new Promise((r) => setTimeout(r, 300))
  expect(watched.value.reports).toEqual([])
}, 30_000)

it('takes a later report over an earlier one, and dismisses all at once', async () => {
  await up({ tickMs: 100 }, 'echo')
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  const one = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'One', prompt: 'First from one' })
  await daemon!.idle(one.id)
  const two = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Two', prompt: 'From two' })
  await daemon!.idle(two.id)
  await watched.until((b) => b.reports.length === 2, 'both reported')
  expect(watched.value.reports.map((r) => [r.title, r.answer]).sort()).toEqual([['One', 'echo: First from one'], ['Two', 'echo: From two']])
  await daemon!.send(one.id, 'Then from one')
  await watched.until((b) => b.reports[0]?.answer === 'echo: Then from one', 'the later report')
  expect(watched.value.reports.map((r) => [r.title, r.answer])).toEqual([['One', 'echo: Then from one'], ['Two', 'echo: From two']])
  await daemon!.dispatch('staff.dismiss', { id: lead.id })
  await watched.until((b) => b.reports.length === 0, 'all dismissed')
  await new Promise((r) => setTimeout(r, 300))
  expect(watched.value.reports).toEqual([])
})

it('lays out the plan as wave pills and puts decisions under Action required, answered by number with undo', async () => {
  await up({ tickMs: 100 }, [
    callTool('board_plan', { title: 'Colony polish', summary: 'Wave 1 is under way.', waves: [{ title: 'Feel', lanes: ['Ranger feel', 'Sound'] }] }),
    callTool('board_ask', { question: 'Worth a sprite?', options: ['Own sprite', { label: 'Keep the pill', description: 'as now' }], about: ['Ranger feel'] }),
    callTool('board_ask', { question: 'Ship the lookbook?', options: ['Yes', 'No'] }),
    say('On the board.'),
    say('Noted.'), say('Noted.'),
  ])
  const lead = await daemon!.thread('Plan it', { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.decisions.length === 2 && Boolean(b.plan), 'the plan and decisions')
  const [sprite, ship] = watched.value.decisions

  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('Worth a sprite?'), 'the decision on the board')
  expect(pane.text()).toContain('Colony polish')
  expect(pane.text()).toContain('W1 · Feel')
  expect(pane.text()).toContain('Action required')
  expect(pane.text()).toContain('2 need you')
  pane.find('.staff-board')!.focus()

  // 1 picks, z takes it back: nothing goes.
  await window.key('1')
  expect(pane.text()).toContain('Sending “Own sprite”')
  await window.key('z')
  expect(pane.text()).not.toContain('Sending')
  // 2 picks and sends after undo window.
  await window.key('2')
  await daemon!.until(async () => (await said(lead.id, `Decision ${sprite!.id}: Worth a sprite?\\n→ Keep the pill`)) > 0, 'the lead told')
  expect(await said(lead.id, '→ Own sprite')).toBe(0)
  await watched.until((b) => b.decisions[0]?.answer?.text === 'Keep the pill', 'answered on the board')
  await window.until(() => pane.text().includes('1 needs you'), 'one left open')
  expect(pane.find('.staff-board__section--action')!.textContent).not.toContain('Worth a sprite?')
  expect(pane.text()).toContain('Answered')
  expect(pane.text()).not.toContain('→ Keep the pill')

  // n goes to next open question; r answers in words.
  await window.key('n')
  await window.key('r')
  await window.type('.staff-board__reply', 'Not yet')
  await window.key('enter')
  await daemon!.until(async () => (await said(lead.id, `Decision ${ship!.id}: Ship the lookbook?\\n→ Not yet`)) > 0, 'the words sent')

  // Nothing in Action required now; space unfolds Answered, x dismisses.
  await window.until(() => !pane.find('.staff-board__section--action'), 'nothing open')
  await expect(daemon!.dispatch('staff.decide', { id: lead.id, decision: sprite!.id, text: 'Own sprite' })).rejects.toThrow('already answered')
  await pane.click('[data-key="section:answered"]')
  await window.until(() => pane.text().includes('→ Keep the pill') && pane.text().includes('→ Not yet'), 'unfolded')
  await window.key('j')
  await window.key('x')
  await watched.until((b) => b.decisions.length === 1, 'dismissed')
  expect(watched.value.decisions[0]!.id).toBe(ship!.id)
}, 30_000)

it('keeps the plan and decisions across a restart, and lets the lead close one', async () => {
  await up({ tickMs: 100 }, [
    callTool('board_ask', { question: 'Migrate v2 saves?', options: ['Yes', 'No'] }), say('Asked.'),
  ])
  const lead = await daemon!.thread('Ask', { title: 'Lead' })
  let watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.decisions.length === 1, 'the decision')
  const { id } = watched.value.decisions[0]!
  daemon = await daemon!.restart({ model: [callTool('board_close', { id, note: 'Settled in chat: wipe' }), say('Closed.')] })
  watched = await daemon.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.decisions.length === 1, 'the decision after the restart')
  await daemon.send(lead.id, 'Close it')
  await watched.until((b) => b.decisions[0]?.answer?.by === 'lead', 'closed')
  expect(watched.value.decisions[0]!.answer!.text).toBe('Settled in chat: wipe')
}, 30_000)

it("answers a child's own question on the board, and tells the lead", async () => {
  await up({ tickMs: 100 }, [callTool('ask_user', { question: 'Keep v2 saves loadable?', options: ['Migrate', 'Wipe'] }), say('Ok.'), say('Ok.')])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const save = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Save v3', prompt: 'Do the save format', profile: 'chief-of-staff' })
  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('Keep v2 saves loadable?'), "the child's question on the board", 10_000)
  pane.find('.staff-board')!.focus()
  await window.key('2')
  await daemon!.until(async () => (await said(lead.id, '→ Wipe')) > 0, 'the lead told')
  expect(await daemon!.transcript(lead.id)).toContain(`On the board, the user answered [Save v3](thread:${save.id}): Keep v2 saves loadable?`)
  await window.until(() => !pane.text().includes('Keep v2 saves loadable?'), 'the question gone')
}, 30_000)

it('takes the focus as the window goes to its pane, so keys work at once', async () => {
  await up({ tickMs: 100 }, [callTool('board_ask', { question: 'Worth a sprite?', options: ['Yes', 'No'] }), say('Asked.')])
  const lead = await daemon!.thread('Ask', { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.decisions.length === 1, 'the decision')
  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id }, window: true })
  await window.dispatch('pane.open', { thread: lead.id, kind: PANE })
  await window.until(() => document.activeElement?.classList.contains('staff-board') ?? false, 'the board focused')
  await window.key('1')
  expect(window.window!.text()).toContain('Sending “Yes”')
  await window.key('z')
}, 20_000)

it('tracks queued starts in the plan, promotes their id when started, and filters by wave pill', async () => {
  await up({ tickMs: 100, cap: 1 }, [
    callTool('lane_start', { prompt: 'Do B', title: 'B' }),
    say('B queued.'),
  ])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  // A starts with no prompt: idle with activeAt <= createdAt, so it holds the 1 slot cleanly across a restart too.
  const a = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'A' })
  await daemon!.send(lead.id, 'Queue B')
  let watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.queued.length === 1, 'B queued')
  const queued = watched.value.queued[0]!.id!
  expect(queued).toMatch(/^queued-/)

  daemon = await daemon!.restart({ model: [
    callTool('board_plan', { waves: [{ title: 'One', lanes: [a.id, queued] }, { title: 'Two', lanes: ['Sound'] }] }),
    say('Planned.'),
    say('Ok.'),
    say('Ok.'),
  ] })
  watched = await daemon.watch<Board>(BOARD, { scope: lead.id })
  await daemon.send(lead.id, 'Plan it')
  await watched.until((b) => Boolean(b.plan), 'the plan')

  window = await mountUi({ machines: [daemon], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('W2 · Two'), 'the wave pills')
  expect(pane.text()).toContain('B')
  expect(pane.text()).toContain('Sound')

  // Clicking W2 filters down to Wave 2 only (the PaneHeader still shows "1 queued", so check the board body).
  await pane.click('button[title^="Filter to Wave 2"]')
  await window.until(() => !pane.find('.staff-board__body')!.textContent!.includes('B') && pane.find('.staff-board__body')!.textContent!.includes('Sound'), 'filtered to Wave 2')
  // Clicking again clears the filter.
  await pane.click('button[title^="Filter to Wave 2"]')
  await window.until(() => pane.find('.staff-board__body')!.textContent!.includes('B'), 'filter cleared')

  // A is archived: B starts, and its lane id in the plan becomes its thread id.
  await daemon.dispatch('thread.archive', { thread: a.id })
  await daemon.until(async () => (await childrenOf(lead.id)).some((c) => c.title === 'B'), 'B started')
  const b = (await childrenOf(lead.id)).find((c) => c.title === 'B')!
  await watched.until((x) => x.plan?.waves[0]?.lanes[1] === b.id, "B's lane its thread's")
  expect(watched.value.plan!.waves.map((w) => w.lanes)).toEqual([[a.id, b.id], ['Sound']])
}, 30_000)

it("clears the board once a programme's done: settled reports, answered decisions and the plan; not what runs, asks or waits", async () => {
  await up({ tickMs: 100, cap: 0 }, [
    callTool('board_plan', { title: 'Polish', summary: 'Under way.', waves: [{ title: 'One', lanes: ['A'] }] }),
    callTool('board_ask', { question: 'Still open?', options: ['Yes', 'No'] }),
    callTool('board_ask', { question: 'Answered?', options: ['Yes', 'No'] }),
    callTool('lane_start', { prompt: 'Later', title: 'Later' }),
    say('Set.'),
    say('Noted.'), say('Done here.'), say('Gone too.'), say('First pass.'), callTool('bash', { command: 'sleep 4' }), say('Second pass.'),
    callTool('board_clear', {}), say('Cleared.'),
  ])
  const lead = await daemon!.thread('Set it up', { title: 'Lead' })
  const watched = await daemon!.watch<Board>(BOARD, { scope: lead.id })
  await watched.until((b) => b.decisions.length === 2 && Boolean(b.plan) && b.queued.length === 1, 'the programme on the board')
  const [open, answered] = watched.value.decisions
  await daemon!.dispatch('staff.decide', { id: lead.id, decision: answered!.id, text: 'Yes' })
  await daemon!.until(async () => (await daemon!.transcript(lead.id)).includes('Noted.'), 'the lead told')
  await daemon!.idle(lead.id)

  const done = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Done', prompt: 'Do it' })
  await daemon!.idle(done.id)
  const gone = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Gone', prompt: 'Do it' })
  await daemon!.idle(gone.id)
  const busy = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Busy', prompt: 'Do it' })
  await daemon!.idle(busy.id)
  await watched.until((b) => b.reports.length === 3, 'all three reported')
  await daemon!.dispatch('thread.archive', { thread: gone.id })
  const again = daemon!.send(busy.id, 'Again')
  await daemon!.until(async () => (await childrenOf(lead.id)).find((c) => c.id === busy.id)?.status.state === 'working', 'Busy at work')

  window = await mountUi({ machines: [daemon!], profile: { ref: lead.profile!, extensions: [board] }, select: { thread: lead.id } })
  const pane = await window.render({ pane: { kind: PANE }, thread: lead.id })
  await window.until(() => pane.text().includes('Polish'), 'the board')
  expect((pane.find('button[title^="Settled reports"]') as HTMLButtonElement).disabled).toBe(false)
  pane.find('.staff-board')!.focus()
  await window.key('shift+x')
  await watched.until((b) => !b.plan && b.decisions.length === 1 && b.reports.length === 1, 'cleared')
  expect(watched.value.reports[0]!.id).toBe(busy.id)
  expect(watched.value.decisions[0]!.id).toBe(open!.id)
  expect(watched.value.queued).toHaveLength(1)
  await window.until(() => !pane.text().includes('Polish'), 'the plan gone from the board')
  expect((pane.find('button[title^="Settled reports"]') as HTMLButtonElement).disabled).toBe(true)

  await again
  await watched.until((b) => b.reports[0]?.answer === 'Second pass.', "Busy's new report")
  await daemon!.send(lead.id, 'Clear the board')
  await daemon!.until(async () => (await daemon!.transcript(lead.id)).includes('Cleared.'), 'the lead cleared it')
  expect(await daemon!.transcript(lead.id)).toContain('Cleared 1 report from the board.')
  await watched.until((b) => b.reports.length === 0, "Busy's report cleared")
  expect(watched.value.decisions.map((d) => d.id)).toEqual([open!.id])
  expect(watched.value.queued).toHaveLength(1)
}, 40_000)

it('collapses cross-thread chatter (reports, watchdog, queue starts, board relays) and leaves normal messages alone', () => {
  const fromReport = readChatter([{ type: 'text', text: 'From [Ziplines](thread:42): finished.\n\nAll 431 tests pass.' }])
  expect(fromReport).toMatchObject({
    blocks: [0],
    items: [{ kind: 'from', threadId: '42', threadTitle: 'Ziplines', summary: 'finished.' }],
  })

  const fromLead = readChatter([{ type: 'text', text: 'From [Chief of staff](thread:1):\n\nPlease rebase onto main.' }])
  expect(fromLead).toMatchObject({
    blocks: [0],
    items: [{ kind: 'from', threadId: '1', threadTitle: 'Chief of staff', summary: 'Please rebase onto main.' }],
  })

  const watchdog = readChatter([{ type: 'text', text: 'Watchdog: [Smoke](thread:9) has made no progress for 15 min, in bash (`sleep 960`).' }])
  expect(watchdog).toMatchObject({
    blocks: [0],
    items: [{ kind: 'watchdog', threadId: '9', threadTitle: 'Smoke' }],
  })

  const queued = readChatter([{ type: 'text', text: 'Started [B](thread:12) (id 12) from the queue.' }])
  expect(queued).toMatchObject({
    blocks: [0],
    items: [{ kind: 'queued', threadId: '12', threadTitle: 'B', summary: 'started from queue' }],
  })

  const relay = readChatter([{ type: 'text', text: 'On the board, the user answered [Save v3](thread:7): Keep v2?\n→ Wipe' }])
  expect(relay).toMatchObject({
    blocks: [0],
    items: [{ kind: 'relay', threadId: '7', threadTitle: 'Save v3', summary: 'answered → Wipe' }],
  })

  // Normal user messages are never claimed.
  expect(readChatter([{ type: 'text', text: 'How are things looking?' }])).toBeUndefined()
  expect(readChatter([{ type: 'text', text: 'From now on use strict mode' }])).toBeUndefined()
})

it("draws the Staff sidebar: what waits on the user, then a card per lead with its lanes, each linked with its status", async () => {
  await up({ tickMs: 100 }, [say('Lane done.'), callTool('board_ask', { question: 'Worth a sprite?', options: ['Yes', 'No'] }), say('Asked.')])
  const lead = await daemon!.thread(undefined, { title: 'Lead' })
  const sidebar = await daemon!.watch<Block[]>('staff.sidebar')
  const lane = await daemon!.call<ThreadInfo>('thread.start', { parent: lead.id, title: 'Lane', prompt: 'Do it' })
  await daemon!.idle(lane.id)
  const card = (blocks: Block[]) => blocks.find((b) => b.type === 'card') as Extract<Block, { type: 'card' }> | undefined
  const items = (blocks: Block[]) => (card(blocks)?.blocks ?? []).flatMap((b) => b.type === 'list' ? b.items : [])
  await sidebar.until((b) => items(b).some((i) => i.thread === lane.id && i.status === 'done'), "the lane in its lead's card")
  expect(items(sidebar.value).map((i) => i.thread)).toEqual([lead.id, lane.id])
  expect(items(sidebar.value)[0]).toMatchObject({ title: 'Lead', detail: '1 lane' })
  expect(items(sidebar.value)[1]).toMatchObject({ title: 'Lane', subtitle: 'now' })
  expect(sidebar.value.some((b) => b.type === 'callout')).toBe(false)
  expect(blockErrors(sidebar.value, { by: 'extension', extension: 'staff', thread: false })).toEqual([])

  // A decision on the lead's board waits on the user; archived, the lane is off its card.
  await daemon!.call('thread.send', { thread: lead.id, text: 'Ask' })
  await sidebar.until((b) => b.some((x) => x.type === 'callout' && x.text.includes("1 decision on **Lead**'s board")), 'the open decision called out')
  await daemon!.call('thread.archive', { thread: lane.id })
  await sidebar.until((b) => items(b).length === 1, 'the archived lane gone')
}, 20_000)
