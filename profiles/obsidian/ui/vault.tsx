// vault, UI half: the graph and note panes, the Vault space (a rail button opens it), and [[wikilinks]] in this
// profile's threads opening the note the vault finds. The profile is global (for the space), so what it registers
// reaches every thread: links and the note pane hold back in other profiles' threads.
import {
  call, defineAction, defineUiExtension, parseWikilink, RailButton, TreeStructureIcon, useDispatch, type ViewProps,
} from 'superego/ui'
import { obj, str } from 'superego'
import { about, PROFILE, SPACE, type NoteInfo } from '../shared.ts'
import { GraphPane } from './graph.tsx'
import { NotePane, noteTitle, ours, noteName } from './note.tsx'
import { VaultSpace, type Shown } from './space.tsx'

export default defineUiExtension({
  ...about,
  setup(superego) {
    /** The space on screen, if it is, and its thread: links followed there show their note in it. */
    const shown = superego.store<Shown>('shown', null)
    /** The note last shown in the space: the rail opens it again. */
    const last = superego.store<string | null>('last', null, { persist: true })

    superego.pane('graph', { title: 'Graph', component: GraphPane, menu: true })
    // Notes named in the thread ([[GitHub]], `Work/GitHub/GitHub.md`) open in the note pane.
    superego.pane('note', { title: noteTitle, component: NotePane, opens: (path) => /\.md$/i.test(path) })

    superego.space(SPACE, {
      title: (params) => noteName(typeof params.path === 'string' ? params.path : undefined) ?? 'Vault',
      icon: TreeStructureIcon,
      component: (props) => <VaultSpace {...props} shown={shown} last={last} />,
      about: (params) => typeof params.path === 'string'
        ? `The user has the note ${params.path} open in the Vault space, beside its list of notes.`
        : "The user has the Vault space open: the vault's notes, newest first.",
      profile: PROFILE,
      agent: 'docked',
    })
    function VaultButton({ machine }: ViewProps<'window'>) {
      const dispatch = useDispatch()
      const here = shown.use()
      if (!machine) return null
      const openSpace = () => { const path = last.get(); return dispatch('space.open', { kind: SPACE, params: path ? { path } : {}, machine: machine.id }) }
      return (
        <RailButton label="Vault" on={here?.machine === machine.id}
          onClick={() => void openSpace().catch((e: Error) => console.error('[vault] opening the space failed:', e))}>
          <TreeStructureIcon size={18} aria-hidden />
        </RailButton>
      )
    }
    superego.view('vault.rail', { title: 'Vault', icon: TreeStructureIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', component: VaultButton })
    superego.action(defineAction({
      id: 'vault.settings', title: 'Choose the Obsidian vault', params: obj({ machine: str() }),
      run: ({ machine }, context) => context.openSettings(machine),
    }))

    // [[wikilinks]], ahead of the core's (which looks for a file of that name): the note the vault finds, in the note
    // pane (in the space, if that's where it was followed), at its heading. Why not, if the vault has no such note.
    // Only in this profile's threads, and where there's no thread (a space).
    superego.link({
      match: (href, _kind, where) => href.startsWith('wikilink:') && (!where.thread || ours(where.thread)),
      scheme: 'wikilink',
      async open(href, { machine, thread }) {
        const link = parseWikilink(href)
        if (!machine || !link?.target) return 'not a note'
        const params = { path: link.target, ...(link.heading ? { heading: link.heading } : {}), ...(link.block ? { block: link.block } : {}) }
        try {
          const found = await call<NoteInfo>(machine, 'vault.note', { ...(thread ? { thread: thread.id } : {}), ...params })
          const here = shown.get()
          if (!thread || (here?.machine === machine && here.thread === thread.id)) {
            await superego.dispatch('space.open', { kind: SPACE, params: { ...params, path: found.path }, machine })
          } else {
            await superego.dispatch('pane.open', { thread: thread.id, kind: 'note', title: found.title, params: { ...params, path: found.path } }, { machine })
          }
          return undefined
        } catch (error) { return (error as Error).message }
      },
      target: (href) => { const link = parseWikilink(href); return link ? `${link.target}${link.heading ? ` › ${link.heading}` : ''}` : href },
    })
    const css = `
      .vault-graph { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .vault-graph__canvas { flex: 1; width: 100%; min-height: 0; cursor: grab; touch-action: none; }
      .vault-graph__legend { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; font-size: 12px; color: var(--superego-muted); }
      .vault-graph__legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
      .vault-note__backlinks { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--superego-border); display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
      .vault-note__backlinks a { color: var(--superego-accent); text-decoration: none; }
      .vault-note__backlinks h3 { width: 100%; margin: 0 0 4px; font-size: 12px; color: var(--superego-muted); font-weight: 600; }
      .vault-note { flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .vault-note__bar { display: flex; align-items: center; gap: var(--superego-space-2); padding: 6px 12px; font-size: var(--superego-text-sm); color: var(--superego-muted); }
      .vault-note__path { flex: 1; min-width: 0; font-family: var(--superego-mono); color: var(--superego-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .vault-space { display: flex; height: 100%; min-height: 0; min-width: 0; padding-right: var(--space-inset-right, 0px); }
      .vault-space__side { flex: 0 0 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--superego-border); }
      .vault-space__filter { margin: 10px 10px 6px; }
      .vault-space__warning { margin: 0 10px 6px; font-size: var(--superego-text-sm); color: var(--superego-muted); }
      .vault-space__list { flex: 1; overflow: auto; padding: 0 6px 24px; display: flex; flex-direction: column; gap: 1px; }
      .vault-space__row { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title at" "folder at"; column-gap: 8px; width: 100%; border: 0; background: none; font: inherit; color: var(--superego-text); text-align: left; padding: 5px 8px; border-radius: var(--superego-radius); cursor: default; }
      .vault-space__row:hover { background: var(--superego-hover); }
      .vault-space__row.is-current { background: var(--superego-selected); }
      .vault-space__title { grid-area: title; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .vault-space__folder { grid-area: folder; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--superego-faint); font-size: var(--superego-text-sm); }
      .vault-space__folder:empty { display: none; }
      .vault-space__at { grid-area: at; align-self: center; color: var(--superego-faint); font-size: var(--superego-text-sm); }
      .vault-space__quiet { padding: 6px 8px; color: var(--superego-muted); font-size: var(--superego-text-sm); }
      .vault-space__note { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .vault-space__unset { margin: auto; display: flex; flex-direction: column; align-items: center; gap: var(--superego-space-3); color: var(--superego-muted); padding: 24px; text-align: center; }
    `
    // Only this profile's own UI gets it, gone with the UI.
    superego.style(css)
  },
})
