// The chief of staff's machinery, for threads with this profile (its "leads"):
// - owns the worker boundary (lane_start, lane_send, lane_read, lane_list, lane_archive) instead of wrapping raw
//   thread-tools; workers start with the `chief-of-staff-worker` profile (no thread-tools) so siblings cannot
//   thread_send each other;
// - single-slot held mailbox per working lane: lane_send on a working child never piles follow-ups into its inbox;
//   notes are held/coalesced in lead state and delivered as one message when the lane goes idle (or dropped on the
//   board or via lane_drop_note);
// - watchdog over working children, live tool activity, branch changes, reports kept until dismissed, plan & decisions.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  arr, bool, defineAction, defineDaemonExtension, defineExtension, defineTool, obj, opt, RpcError, str, union,
  type Block, type ThreadInfo,
} from 'superego'
import {
  about, BOARD, EMPTY_BOARD, type Board, type Changes, type Decision, type Details, type HeldNote, type Plan, type Report,
} from './shared.ts'

const PROFILE = 'chief-of-staff'
const WORKER_PROFILE = 'chief-of-staff-worker'
const MINUTE = 60_000
const ANSWER_CLIP = 6_000
const REPORT_ANSWER = 4_000

type Start = { prompt: string; title?: string; cwd?: string; profile?: string; worktree?: boolean }
/** A start waiting for a slot. `id`, to name it in the plan's lanes until it starts (older ones have none). */
type Queued = { args: Start; at: number; id?: string }
/** `reported`: by child, the activity (activeAt) its last report was of, so each is recorded once, dismissed or not. */
type State = {
  queue?: Queued[]
  held?: Record<string, HeldNote>
  reports?: Report[]
  reported?: Record<string, number>
  plan?: Plan
  decisions?: Decision[]
}
/** A thread's worktree, as the worktrees extension tells it (`facts.worktrees`). */
type Worktree = { path: string; branch: string; removed?: boolean }

export type StaffOptions = {
  /** How often it looks: the watchdog, due check-ins, live activity and the queue. */
  tickMs?: number
  /** A working child with no new transcript entry for this long is stalled. */
  stallMs?: number
  /** Children running at once, before lane_start queues. */
  cap?: number
  /** Default profile for started workers (`chief-of-staff-worker`; override in tests where only one profile exists). */
  workerProfile?: string | null
}

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
/** A decision's options take a number key each on the board: at most nine. */
const OPTIONS = 9
const linkTo = (t: { id: string; title: string }) => `[${t.title.replace(/[[\]]/g, '')}](thread:${t.id})`
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / MINUTE))} min`
const worktreeOf = (t: ThreadInfo) => t.facts?.worktrees as Worktree | undefined

/** Whether it takes a slot: working, waiting on the user, or just started and not yet going. */
const running = (t: ThreadInfo, now: number) => !t.archived &&
  (t.status.state === 'working' || t.status.state === 'blocked' || (t.status.state === 'idle' && now - t.createdAt < MINUTE && t.activeAt <= t.createdAt))

const git = (cwd: string, ...args: string[]) => new Promise<string | undefined>((resolve) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 5_000 }, (error, out) => resolve(error ? undefined : out.trim()))
})

/** A worktree child's branch, and where to run git on it (the main checkout, once the worktree is gone). */
function branchOf(t: ThreadInfo) {
  const tree = worktreeOf(t)
  return tree && { branch: tree.branch, at: tree.removed ? t.project.root : tree.path }
}

/** Whether a worktree's branch is in the local main: it moved since it was made (its reflog) and main has all of it. */
async function mergedOf(t: ThreadInfo): Promise<boolean | undefined> {
  const tree = branchOf(t)
  if (!tree) return undefined
  const { at } = tree
  const main = (await git(at, 'rev-parse', '--verify', '-q', 'refs/heads/main')) ? 'main' : (await git(at, 'rev-parse', '--verify', '-q', 'refs/heads/master')) ? 'master' : undefined
  if (!main) return undefined
  const ahead = await git(at, 'rev-list', '--count', `${main}..${tree.branch}`)
  if (ahead === undefined) return undefined
  if (ahead !== '0') return false
  const moves = await git(at, 'reflog', 'show', '--format=%H', `refs/heads/${tree.branch}`)
  return moves ? moves.split('\n').length > 1 : undefined
}

const FILES = 30
/**
 * What a branch changed since it left main, merged or not: from the commit it was last rebased onto, else the one it was
 * made at (its reflog), to its tip. Committed work only.
 */
async function changesOf(at: string, branch: string): Promise<Changes | undefined> {
  const log = (await git(at, 'reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`) || undefined)?.split('\n')
  if (!log) return undefined
  const base = log.map((l) => / onto ([0-9a-f]{40})$/.exec(l)?.[1]).find(Boolean) ?? log.at(-1)!.split(' ')[0]
  // Three dots: from where the two meet, should the base not be an ancestor any more (a reset).
  const out = await git(at, 'diff', '--numstat', `${base}...refs/heads/${branch}`)
  if (out === undefined) return undefined
  const files = out.split('\n').filter(Boolean).map((l) => {
    const [added, removed, ...path] = l.split('\t')
    // Binary files count no lines ("-").
    return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }
  })
  const sum = (k: 'added' | 'removed') => files.reduce((n, f) => n + f[k], 0)
  return { files: files.slice(0, FILES), added: sum('added'), removed: sum('removed'), ...(files.length > FILES ? { more: files.length - FILES } : {}) }
}

/** How a child stands as a report, if it's one: it answered, failed, or waits on a question. Not while it works or signs in. */
function outcomeOf(t: ThreadInfo, now: number): Report['outcome'] | undefined {
  const { state, kind } = t.status
  if (state === 'working' || (state === 'blocked' && kind === 'auth') || (state === 'idle' && running(t, now))) return undefined
  return state === 'blocked' ? 'question' : state === 'error' ? 'error' : 'done'
}

type Entry = { kind: string; model?: readonly unknown[] }
/** The tool call a thread is in now, from its newest entries: its name and what it's on (a command, a path). */
function callOf(entries: readonly Entry[]) {
  const done = new Set<string>()
  for (const entry of entries) {
    for (const message of (entry.model ?? []) as { role?: string; toolCallId?: string; content?: unknown }[]) {
      if (message.role === 'toolResult' && message.toolCallId) done.add(message.toolCallId)
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
        if (block.type !== 'toolCall' || !block.id || done.has(block.id)) continue
        const args = block.arguments ?? {}
        const on = [args.command, args.path, args.id, args.title].find((v) => typeof v === 'string') as string | undefined
        return on ? `${block.name} (\`${on.split('\n')[0]!.slice(0, 80)}\`)` : block.name
      }
      return undefined
    }
  }
  return undefined
}

/** How long ago, in a word: "now", "5m", "3h", "2d". */
const ago = (ms: number) => ms < MINUTE ? 'now' : ms < 60 * MINUTE ? `${Math.floor(ms / MINUTE)}m ago` : ms < 24 * 60 * MINUTE ? `${Math.floor(ms / (60 * MINUTE))}h ago` : `${Math.floor(ms / (24 * 60 * MINUTE))}d ago`
/** A line of a thread's own, short: how long since it last moved, and what its status says when it's stuck. */
const lineOf = (t: ThreadInfo, now: number) => {
  const msg = (t.status.state === 'blocked' || t.status.state === 'error') && t.status.msg?.split('\n')[0]?.trim()
  return msg ? `${ago(now - t.activeAt)} · ${msg.length > 80 ? `${msg.slice(0, 79)}…` : msg}` : ago(now - t.activeAt)
}
const itemOf = (t: ThreadInfo, now: number) => ({ title: t.title, thread: t.id, status: t.status.state, subtitle: lineOf(t, now) })

/**
 * The Staff space: what's waiting on the user (threads blocked on them, and the boards' open decisions) in a callout,
 * then a card per lead, its project's name over it and itself first, then its lanes (its children not archived), each
 * linked, with its status and how long since it moved. `open`: each lead's open decisions on its board.
 */
export function spaceOf(threads: ThreadInfo[], open: Record<string, number>, now: number): Block[] {
  const leads = threads.filter((t) => t.profile?.name === PROFILE && !t.archived).sort((a, b) => b.activeAt - a.activeAt)
  if (!leads.length) return [{ type: 'markdown', text: 'No chief of staff on this machine.' }]
  const lanesOf = (lead: ThreadInfo) => threads.filter((t) => t.parent === lead.id && !t.archived).sort((a, b) => b.activeAt - a.activeAt)
  const waiting = [
    ...leads.flatMap((lead) => [lead, ...lanesOf(lead)]).filter((t) => t.status.state === 'blocked').map((t) => `**${t.title}**`),
    ...leads.filter((l) => open[l.id]).map((l) => `${open[l.id]} ${open[l.id] === 1 ? 'decision' : 'decisions'} on **${l.title}**'s board`),
  ]
  return [
    ...(waiting.length ? [{ type: 'callout' as const, tone: 'warn' as const, title: 'Waiting on you', text: waiting.join(', ') }] : []),
    ...leads.map((lead): Block => {
      const lanes = lanesOf(lead)
      return {
        type: 'card', title: lead.project.name, blocks: [
          { type: 'list', items: [{ ...itemOf(lead, now), detail: lanes.length ? `${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'}` : 'no lanes' }] },
          ...(lanes.length ? [{ type: 'list' as const, items: lanes.map((t) => itemOf(t, now)) }] : []),
        ],
      }
    }),
  ]
}

export function staff({ tickMs = 30_000, stallMs = 15 * MINUTE, cap = 4, workerProfile = WORKER_PROFILE }: StaffOptions = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const state = superego.state<State>()
      const isLead = (t: ThreadInfo) => t.profile?.name === PROFILE && !t.archived
      /** What each lead's board shows besides what the window knows of threads. */
      const board = superego.scopedValue<Board>(BOARD, EMPTY_BOARD)
      /** The stall each child was last reported for (its activity then), so it's told once. */
      const warned = new Map<string, number>()
      const tell = (lead: string, message: string) => superego.threads.send(lead, message, { whenBusy: 'followUp' })
      /** The thread a tool call's conversation is. */
      const threadOf = (conversationId: number) => superego.threads.of(conversationId)
      const answerOf = (id: string) => superego.threads.lastAnswer(id).catch(() => undefined)

      // The Staff space (a rail tab and its sidebar): every lead here and its lanes, built again as threads change (on
      // the tick, and as a lead's turns start and end) and set only when it's different. Each machine has its own; the
      // window shows every machine's under its name.
      const space = superego.value<Block[]>('staff.space', [])
      superego.view('staff.space', { title: 'Staff', icon: 'columns', context: 'window', fits: ['space', 'beside'], default: 'space', value: 'staff.space' })
      let shown = ''
      async function refresh() {
        const all = await superego.threads.list()
        const open: Record<string, number> = {}
        for (const lead of all.filter(isLead)) open[lead.id] = ((await state.get(lead.id))?.decisions ?? []).filter((d) => !d.answer).length
        const blocks = spaceOf(all, open, Date.now())
        const json = JSON.stringify(blocks)
        if (json === shown || superego.signal.aborted) return
        shown = json
        space.set(blocks)
      }
      const redraw = () => { refresh().catch((error) => console.error('staff: the Staff space failed to build:', error)) }

      /** Each worktree child's changes, worked out again only when it moved on and its branch's tip with it. */
      const known = new Map<string, { activeAt: number; tip?: string; changes?: Changes }>()
      async function changes(t: ThreadInfo) {
        const tree = branchOf(t)
        if (!tree) return undefined
        const last = known.get(t.id)
        if (last?.activeAt === t.activeAt) return last.changes
        const tip = await git(tree.at, 'rev-parse', '-q', '--verify', `refs/heads/${tree.branch}`)
        const next = tip && tip === last?.tip ? last.changes : tip ? await changesOf(tree.at, tree.branch) : undefined
        known.set(t.id, { activeAt: t.activeAt, tip, changes: next })
        return next
      }

      /** A child's report as it stands: what it said (its answer, error or question) and what its branch changed. */
      async function reportOf(child: ThreadInfo, outcome: Report['outcome'], at: number): Promise<Report | undefined> {
        const answer = outcome === 'done' ? await answerOf(child.id) : child.status.msg
        // Idle with nothing said: not started yet, more likely than finished.
        if (!answer && child.status.state === 'idle') return undefined
        const tree = branchOf(child)
        const [changed, merged] = tree ? await Promise.all([changes(child), mergedOf(child)]) : []
        return {
          id: child.id, title: child.title, at, outcome, answer: (answer ?? '').trim().slice(0, REPORT_ANSWER),
          ...(tree ? { branch: tree.branch } : {}), ...(changed ? { changes: changed } : {}), ...(merged !== undefined ? { merged } : {}),
        }
      }

      /** What the board shows straight from a lead's state: held notes, reports, plan and decisions. */
      const kept = (s: State | undefined) => ({
        held: s?.held ?? {},
        reports: s?.reports ?? [],
        decisions: s?.decisions ?? [],
        ...(s?.plan ? { plan: s.plan } : {}),
      })
      /** Change a lead's state, and its board with it at once rather than on the next tick. */
      async function keep(lead: string, edit: (s: State) => State) {
        await state.update(lead, (s) => edit(s ?? {}))
        const next = await state.get(lead)
        board.update(lead, (b) => ({
          ...(b ?? EMPTY_BOARD),
          queued: (next?.queue ?? []).map((q) => ({ ...(q.id ? { id: q.id } : {}), title: q.args.title ?? q.args.prompt.slice(0, 60), at: q.at })),
          ...kept(next),
        }))
        redraw()
        return next
      }

      /**
       * Clear a lead's board once a programme's done: the reports of children done with (finished, failed or archived),
       * the answered decisions and the plan. Running children (stalled or asking too), open decisions, held notes on
       * running children, and queued starts stay.
       */
      async function clear(lead: string) {
        const at = Date.now()
        const live = (await superego.threads.list()).filter((t) => t.parent === lead && running(t, at)).map((t) => t.id)
        let cleared = { reports: 0, decisions: 0, plan: false }
        await keep(lead, ({ plan, ...s }) => {
          const reports = (s.reports ?? []).filter((r) => live.includes(r.id))
          const decisions = (s.decisions ?? []).filter((d) => !d.answer)
          cleared = { reports: (s.reports ?? []).length - reports.length, decisions: (s.decisions ?? []).length - decisions.length, plan: Boolean(plan) }
          return { ...s, reports, decisions }
        })
        return cleared
      }

      /** The lead of the thread a tool call is in. */
      const leadOf = (conversationId: number) => {
        const id = threadOf(conversationId)
        if (!id) throw new Error('Only a thread can use chief-of-staff tools')
        return id
      }

      async function startWorker(lead: ThreadInfo, { worktree, profile, ...args }: Start) {
        const options = worktree !== undefined ? { options: { worktrees: worktree } } : {}
        const chosenProfile = profile ?? (workerProfile ?? undefined)
        return await superego.threads.start({
          ...args,
          cwd: args.cwd ?? lead.cwd,
          parent: lead.id,
          ...(chosenProfile ? { profile: chosenProfile } : {}),
          ...options,
        })
      }

      /** Send a single signed message from `lead` to `child`. */
      async function sendToChild(lead: ThreadInfo, childId: string, body: string) {
        const signed = `From ${linkTo(lead)}:\n\n${body.trim()}`
        await superego.threads.send(childId, signed, { whenBusy: 'followUp', from: lead.id })
      }

      async function tick() {
        const all = await superego.threads.list()
        const at = Date.now()
        const leads = all.filter(isLead)
        for (const lead of leads) {
          if (superego.signal.aborted) return
          // One lead's trouble doesn't keep the others from their tick.
          try { await tickLead(lead) } catch (error) { console.error(`staff: tick failed for lead ${lead.id}:`, error) }
        }
        for (const id of known.keys()) if (!all.some((t) => t.id === id && !t.archived)) known.delete(id)
        for (const id of board.scopes()) if (!leads.some((l) => l.id === id)) board.delete(id)
        redraw()

        async function tickLead(lead: ThreadInfo) {
          const children = all.filter((t) => t.parent === lead.id && !t.archived)
          const liveIds = new Set(children.map((c) => c.id))
          let mine = (await state.get(lead.id)) ?? {}
          const notes: string[] = []

          // Live activity + watchdog for every working child.
          const activity: Board['activity'] = {}
          const stalled: Board['stalled'] = {}
          for (const child of children) {
            if (child.status.state !== 'working') {
              warned.delete(child.id)
              continue
            }
            const call = callOf(await superego.threads.entries(child.id, 10).catch(() => []) as unknown as Entry[])
            if (call) activity[child.id] = call
            if (at - child.activeAt < stallMs) {
              warned.delete(child.id)
              continue
            }
            stalled[child.id] = { since: child.activeAt, ...(call ? { call } : {}) }
            if (warned.get(child.id) === child.activeAt) continue
            warned.set(child.id, child.activeAt)
            notes.push(`Watchdog: ${linkTo(child)} has made no progress for ${minutes(at - child.activeAt)}${call ? `, in ${call}` : ''}.`)
          }

          // Held notes: drop notes for archived/gone children; deliver held note once a child is idle/done/error.
          if (mine.held && Object.keys(mine.held).length) {
            const heldEntries = Object.entries(mine.held)
            for (const [childId, held] of heldEntries) {
              const child = children.find((c) => c.id === childId)
              if (!child) {
                await state.update(lead.id, (s) => {
                  if (!s?.held?.[childId]) return s ?? {}
                  const { [childId]: _, ...rest } = s.held
                  return { ...s, held: rest }
                })
                continue
              }
              if (child.status.state === 'working' || child.status.state === 'blocked') continue
              // Child is settled: clear held slot first, then send the single coalesced note.
              await state.update(lead.id, (s) => {
                if (!s?.held?.[childId]) return s ?? {}
                const { [childId]: _, ...rest } = s.held
                return { ...s, held: rest }
              })
              try {
                await sendToChild(lead, child.id, held.text)
              } catch (error) {
                notes.push(`Couldn't deliver held note to ${linkTo(child)}: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            mine = (await state.get(lead.id)) ?? {}
          }

          // Reports: a child that answered, failed or came to wait on a question since it was last reported.
          for (const child of children) {
            const outcome = outcomeOf(child, at)
            if (!outcome || (mine.reported?.[child.id] ?? -1) >= child.activeAt) continue
            const report = await reportOf(child, outcome, at)
            if (!report) continue
            await state.update(lead.id, (s) => ({
              ...s,
              reports: [report, ...(s?.reports ?? []).filter((r) => r.id !== child.id)],
              reported: Object.fromEntries([...Object.entries(s?.reported ?? {}).filter(([id]) => liveIds.has(id)), [child.id, child.activeAt]]),
            }))
            mine = (await state.get(lead.id)) ?? {}
          }

          // What each worktree child's branch has changed so far.
          const changed: Board['changes'] = {}
          for (const child of children) {
            const c = await changes(child)
            if (c?.files.length) changed[child.id] = c
          }

          // Queued starts, as slots free up.
          mine = (await state.get(lead.id)) ?? {}
          let slots = cap - children.filter((t) => running(t, at)).length
          while (slots > 0 && mine.queue?.length) {
            const [next, ...rest] = mine.queue
            await state.update(lead.id, (s) => ({ ...s, queue: rest }))
            mine = { ...mine, queue: rest }
            try {
              const child = await startWorker(lead, next!.args)
              // Its lane in the plan, named by its queue id, is the thread's now.
              if (next!.id && mine.plan?.waves.some((w) => w.lanes.includes(next!.id!))) {
                await state.update(lead.id, (s) => ({
                  ...s, ...(s?.plan ? { plan: { ...s.plan, waves: s.plan.waves.map((w) => ({ ...w, lanes: w.lanes.map((l) => l === next!.id ? child.id : l) })) } } : {}),
                }))
              }
              notes.push(`Started ${linkTo(child)} (id ${child.id}) from the queue${rest.length ? `; ${rest.length} still queued` : ''}.`)
              slots--
            } catch (error) {
              notes.push(`Couldn't start the queued "${next!.args.title ?? 'thread'}": ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          if (superego.signal.aborted) return
          // Read again: a decision, plan, or held note may have come since, and the board shouldn't lose it until the next tick.
          mine = (await state.get(lead.id)) ?? {}
          board.set(lead.id, {
            activity,
            stalled,
            queued: (mine.queue ?? []).map((q) => ({ ...(q.id ? { id: q.id } : {}), title: q.args.title ?? q.args.prompt.slice(0, 60), at: q.at })),
            changes: changed,
            ...kept(mine),
          })
          if (notes.length) await tell(lead.id, notes.join('\n\n'))
        }
      }

      // One tick at a time; a failed one is logged and the next tries again.
      let ticking: Promise<void> | undefined
      const poke = () => {
        ticking ??= tick().catch((error) => console.error('staff: tick failed:', error)).finally(() => { ticking = undefined })
        return ticking
      }
      const timer = setInterval(poke, tickMs)
      // Not awaited: setup stays quick, and doesn't wait on threads (whose profiles may be loading).
      const first = setTimeout(poke, 0)
      superego.signal.addEventListener('abort', () => { clearInterval(timer); clearTimeout(first) })

      // Poke promptly when a lead's turn ends or a thread is archived, so queues/held notes react quickly.
      superego.thread({
        started() { redraw() },
        turnStart() { redraw() },
        turnEnd() { void poke() },
        archived() { void poke() },
        unarchived() { redraw() },
        blocked() { void poke() },
      })

      superego.agent(defineExtension({
        name: 'staff',
        tools: [...laneTools(), ...boardTools()],
      }))

      /** First-class worker tools owned by chief-of-staff (replaces raw thread-tools). */
      function laneTools() {
        return [
          defineTool({
            name: 'lane_start',
            description: 'Start a worker lane (child thread). Beyond the concurrency cap, queues the start and returns a queue id ' +
              'to place in board_plan. Workers run without peer thread_send so all coordination flows through you.',
            executionMode: 'sequential',
            parameters: obj({
              prompt: str({ minLength: 1 }),
              title: opt(str()),
              cwd: opt(str()),
              worktree: opt(bool()),
              profile: opt(str()),
            }),
            async execute(args: Start, api) {
              const id = leadOf(api.conversationId)
              const all = await superego.threads.list()
              const lead = all.find((t) => t.id === id)
              if (!lead) throw new Error(`Lead thread ${id} not found`)
              const busy = all.filter((t) => t.parent === lead.id && running(t, Date.now())).length
              const queued = ((await state.get(lead.id))?.queue ?? []).length
              if (busy < cap && !queued) {
                const child = await startWorker(lead, args)
                void poke()
                return text(`Started ${linkTo(child)} (id ${child.id}).`)
              }
              const queueId = `queued-${randomUUID().slice(0, 6)}`
              await keep(lead.id, (s) => ({ ...s, queue: [...(s.queue ?? []), { args, at: Date.now(), id: queueId }] }))
              void poke()
              return text(`Queued as ${queueId} (${busy} running${queued ? `, ${queued} queued before it` : ''}): it starts when a slot frees up, and you'll be told. ` +
                `Name it ${queueId} in board_plan's lanes; once it starts, its lane is its thread's.`)
            },
          }),
          defineTool({
            name: 'lane_send',
            description: 'Send a follow-up to a lane. If the lane is idle/done/errored, sends immediately. ' +
              'If it is working or waiting on the user, holds a single coalesced note in staff state (never stacking its inbox) ' +
              'and delivers it as one message once the lane finishes. Set replace: true to supersede an earlier held note.',
            parameters: obj({
              thread: str({ minLength: 1 }),
              text: str({ minLength: 1 }),
              replace: opt(bool()),
            }),
            async execute({ thread: childId, text: body, replace }, api) {
              const id = leadOf(api.conversationId)
              const lead = await superego.threads.get(id)
              const child = await superego.threads.get(childId)
              if (child.archived) throw new Error(`${linkTo(child)} is archived; unarchive it before sending.`)

              // Settled: deliver straight away (and clear any stale held note).
              if (child.status.state !== 'working' && child.status.state !== 'blocked') {
                await keep(id, (s) => {
                  if (!s.held?.[childId]) return s
                  const { [childId]: _, ...rest } = s.held
                  return { ...s, held: rest }
                })
                await sendToChild(lead, child.id, body)
                void poke()
                return text(`Sent to ${linkTo(child)}.`)
              }

              // Busy or blocked: coalesce into a single held note instead of piling into the child's inbox.
              const now = Date.now()
              let held!: HeldNote
              await keep(id, (s) => {
                const prev = s.held?.[childId]
                const combined = !prev || replace ? body.trim() : `${prev.text}\n\n---\n\n${body.trim()}`
                held = { text: combined, at: now, count: !prev || replace ? 1 : prev.count + 1 }
                return { ...s, held: { ...(s.held ?? {}), [childId]: held } }
              })
              const call = child.status.state === 'working'
                ? callOf(await superego.threads.entries(child.id, 10).catch(() => []) as unknown as Entry[])
                : undefined
              const doing = child.status.state === 'blocked'
                ? 'is waiting on the user'
                : `is still working (last active ${minutes(now - child.activeAt)} ago${call ? `, in ${call}` : ''})`
              const noteStatus = held.count === 1
                ? (replace ? 'Replaced the held note' : 'Held your note')
                : `Merged into the single held note (${held.count} combined)`
              return text(`${linkTo(child)} ${doing}. ${noteStatus} — it will be delivered as one message when the lane finishes. ` +
                'No need to send again; use lane_drop_note to cancel it, or lane_send with replace: true to supersede it.')
            },
          }),
          defineTool({
            name: 'lane_drop_note',
            description: 'Cancel a held follow-up note for a working lane before it is delivered.',
            parameters: obj({ thread: str({ minLength: 1 }) }),
            async execute({ thread: childId }, api) {
              const id = leadOf(api.conversationId)
              const had = Boolean((await state.get(id))?.held?.[childId])
              if (!had) return text(`No held note for ${childId}.`)
              await keep(id, (s) => {
                const { [childId]: _, ...rest } = s.held ?? {}
                return { ...s, held: rest }
              })
              return text(`Dropped the held note for ${childId}.`)
            },
          }),
          defineTool({
            name: 'lane_read',
            description: 'Read a lane’s status, folder, current tool call (if working), any held note, and last answer. Never blocks.',
            parameters: obj({ thread: str({ minLength: 1 }) }),
            async execute({ thread: childId }, api) {
              const id = leadOf(api.conversationId)
              const child = await superego.threads.get(childId)
              const answer = await answerOf(child.id)
              await superego.threads.noteRead(id, child)
              const call = child.status.state === 'working'
                ? callOf(await superego.threads.entries(child.id, 10).catch(() => []) as unknown as Entry[])
                : undefined
              const held = (await state.get(id))?.held?.[child.id]
              const lines = [
                `${linkTo(child)} (id ${child.id}): ${child.status.state}${child.status.msg ? ` — ${child.status.msg}` : ''}`,
                `Folder: ${child.cwd}`,
                ...(call ? [`Current tool: ${call}`] : []),
                ...(held ? [`Held note (${held.count}): ${held.text}`] : []),
                '',
                answer ? answer.slice(0, ANSWER_CLIP) : '(no answer yet)',
              ]
              return text(lines.join('\n'))
            },
          }),
          defineTool({
            name: 'lane_list',
            description: 'List this lead’s lanes (running, idle, queued) with status, folder, and any held note.',
            parameters: obj({}),
            async execute(_, api) {
              const id = leadOf(api.conversationId)
              const all = await superego.threads.list()
              const mine = (await state.get(id)) ?? {}
              const children = all.filter((t) => t.parent === id && !t.archived)
              const lines: string[] = []
              for (const c of children) {
                const held = mine.held?.[c.id]
                lines.push(`- ${linkTo(c)} (id ${c.id}): ${c.status.state}, ${c.cwd}${held ? ` [held note ×${held.count}]` : ''}`)
              }
              for (const q of mine.queue ?? []) {
                lines.push(`- ${q.args.title ?? q.args.prompt.slice(0, 60)} (${q.id ?? 'queued'}): queued`)
              }
              return text(lines.length ? lines.join('\n') : 'No active or queued lanes.')
            },
          }),
          defineTool({
            name: 'lane_archive',
            description: 'Archive a finished lane (and remove its clean worktree). Refuses a working or blocked lane.',
            parameters: obj({ thread: str({ minLength: 1 }) }),
            async execute({ thread: childId }, api) {
              const id = leadOf(api.conversationId)
              const child = await superego.threads.get(childId)
              if (child.status.state === 'working' || child.status.state === 'blocked') {
                throw new Error(`Cannot archive ${linkTo(child)} while it is ${child.status.state}.`)
              }
              const { notes } = await superego.threads.archive(child.id)
              await keep(id, (s) => {
                if (!s.held?.[child.id]) return s
                const { [child.id]: _, ...rest } = s.held
                return { ...s, held: rest }
              })
              void poke()
              const extra = Object.values(notes).filter(Boolean).join('; ')
              return text(`Archived ${linkTo(child)}.${extra ? ` ${extra}` : ''}`)
            },
          }),
        ]
      }

      // Each live child's last answer in a line, and whether its branch is merged; the merges of reported ones, archived too.
      superego.method('staff.details', async ({ id }): Promise<Details[]> => {
        const children = (await superego.threads.list()).filter((t) => t.parent === id)
        const gone = ((await state.get(id))?.reports ?? []).filter((r) => r.branch && !children.some((c) => c.id === r.id))
        const archived = (await Promise.all(gone.map((r) => superego.threads.get(r.id).catch(() => undefined)))).filter((t) => t !== undefined)
        return Promise.all([...children, ...archived].map(async (child) => {
          const answer = child.archived ? undefined : await answerOf(child.id)
          const merged = await mergedOf(child)
          return { id: child.id, answer: answer?.split('\n').find((l) => l.trim())?.slice(0, 160) ?? null, merged: merged ?? null }
        }))
      }, { params: obj({ id: str() }) })

      // Drop a held follow-up note from the board (or CLI).
      superego.action(defineAction({
        id: 'staff.dropNote', title: 'Drop a held follow-up note for a lane', expose: ['ui', 'cli'],
        params: obj({ id: str(), child: str() }),
        async run({ id, child }) {
          await keep(id, (s) => {
            if (!s.held?.[child]) return s
            const { [child]: _, ...rest } = s.held
            return { ...s, held: rest }
          })
          return null
        },
      }))

      // The user's done with a report or an answered decision (or, with neither, all of a lead's reports and answered
      // decisions): off the board, and out of its state.
      superego.action(defineAction({
        id: 'staff.dismiss', title: 'Dismiss a report or an answered decision on the board', expose: ['ui'],
        params: obj({ id: str(), child: opt(str()), decision: opt(str()) }),
        async run({ id, child, decision }) {
          const all = child === undefined && decision === undefined
          await keep(id, (s) => ({
            ...s,
            reports: (s.reports ?? []).filter((r) => !all && r.id !== child),
            decisions: (s.decisions ?? []).filter((d) => all ? !d.answer : d.id !== decision),
          }))
          return null
        },
      }))

      // The programme's done: the board cleared of what's settled (staff.clear, board_clear).
      superego.action(defineAction({
        id: 'staff.clear', title: 'Clear the board: settled reports, answered decisions and the plan', expose: ['ui'],
        params: obj({ id: str() }),
        async run({ id }) {
          await clear(id)
          return null
        },
      }))

      // The user answers a decision on the board: it's kept as answered, and the lead is told.
      superego.action(defineAction({
        id: 'staff.decide', title: 'Answer a decision on the board', expose: ['ui', 'cli'],
        params: obj({ id: str(), decision: str(), text: str({ minLength: 1 }) }),
        async run({ id, decision, text: answer }) {
          const asked = (await state.get(id))?.decisions?.find((d) => d.id === decision)
          if (!asked) throw new RpcError('not_found', 'That decision is no longer on the board')
          if (asked.answer) throw new RpcError('invalid', 'That decision is already answered')
          const words = answer.trim()
          await keep(id, (s) => ({
            ...s, decisions: (s.decisions ?? []).map((d) => d.id === decision ? { ...d, answer: { text: words, at: Date.now(), by: 'user' as const } } : d),
          }))
          await tell(id, `Decision ${decision}: ${asked.question}\n→ ${words}`)
          return null
        },
      }))

      // The user answered a child's question on the board (agent-ui's answer): the lead hears what was decided.
      superego.action(defineAction({
        id: 'staff.relay', title: "Tell the lead how a child's question was answered on the board", expose: ['ui'],
        params: obj({ id: str(), child: str(), question: str(), text: str() }),
        async run({ id, child, question, text: answer }) {
          const thread = await superego.threads.get(child).catch(() => undefined)
          await tell(id, `On the board, the user answered ${thread ? linkTo(thread) : child}: ${question}\n→ ${answer}`)
          return null
        },
      }))

      /** The lead's board tools: lay out the programme, put a decision to the user, close one, clear the board. */
      function boardTools() {
        return [
          defineTool({
            name: 'board_plan',
            description: "Lay out the programme on the board, the user's overview: a title, a line on where it stands, and its " +
              "waves, each with its lanes. A lane is a thread's id, a queued start's id (it becomes the thread's as it starts), " +
              'or a short title for one not started yet (plan again with its id once it is). Replaces the last plan.',
            parameters: obj({
              title: opt(str()), summary: opt(str()),
              waves: arr(obj({ title: str({ minLength: 1 }), lanes: arr(str({ minLength: 1 })) })),
            }),
            async execute({ title, summary, waves }, api) {
              const plan: Plan = { ...(title ? { title } : {}), ...(summary ? { summary } : {}), waves, at: Date.now() }
              await keep(leadOf(api.conversationId), (s) => ({ ...s, plan }))
              return text(`The board shows ${waves.length} ${waves.length === 1 ? 'wave' : 'waves'}.`)
            },
          }),
          defineTool({
            name: 'board_ask',
            description: 'Put a decision to the user on the board, with options they pick by number (or answer in words). ' +
              "It doesn't wait: their answer comes as a message, \"Decision <id>: <question> → <answer>\". `about`: the threads " +
              'it concerns (ids or titles).',
            parameters: obj({
              question: str({ minLength: 1 }),
              options: arr(union([str({ minLength: 1 }), obj({ label: str({ minLength: 1 }), description: opt(str()) })]), { maxItems: OPTIONS }),
              about: opt(arr(str())),
            }),
            async execute({ question, options, about: concerns }, api) {
              const id = randomUUID().slice(0, 6)
              const decision: Decision = {
                id, question, about: concerns ?? [], at: Date.now(),
                options: options.map((o) => typeof o === 'string' ? { label: o } : { label: o.label, ...(o.description ? { description: o.description } : {}) }),
              }
              await keep(leadOf(api.conversationId), (s) => ({ ...s, decisions: [...(s.decisions ?? []), decision] }))
              return text(`Decision ${id} is on the board. The user's answer comes as a message.`)
            },
          }),
          defineTool({
            name: 'board_close',
            description: 'Close a decision on the board that was settled in chat or no longer matters: shown answered, with the note.',
            parameters: obj({ id: str(), note: opt(str()) }),
            async execute({ id, note }, api) {
              const lead = leadOf(api.conversationId)
              const asked = (await state.get(lead))?.decisions?.find((d) => d.id === id)
              if (!asked) throw new Error(`No decision ${id} on the board`)
              if (asked.answer) return text(`Decision ${id} was already answered: ${asked.answer.text}`)
              await keep(lead, (s) => ({
                ...s, decisions: (s.decisions ?? []).map((d) => d.id === id ? { ...d, answer: { text: note?.trim() || 'Settled', at: Date.now(), by: 'lead' as const } } : d),
              }))
              return text(`Closed decision ${id}.`)
            },
          }),
          defineTool({
            name: 'board_clear',
            description: 'Clear the board once a programme is done: settled reports, answered decisions and the plan; running work and open questions stay.',
            parameters: obj({}),
            async execute(_, api) {
              const { reports, decisions, plan } = await clear(leadOf(api.conversationId))
              const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
              const what = [reports && plural(reports, 'report'), decisions && plural(decisions, 'answered decision'), plan && 'the plan'].filter(Boolean)
              return text(what.length ? `Cleared ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]} from the board.` : 'Nothing to clear.')
            },
          }),
        ]
      }
    },
  })
}

export default staff()
