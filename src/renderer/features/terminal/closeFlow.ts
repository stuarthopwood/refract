import type { TabInfo, TerminalApi } from '../../../shared/ipc-terminal'
import { closeTab } from './terminalTabs'

// The close flow without React: an idle tab closes at once, a tab with a running job asks first (spec 144 FR-012).
// Kept apart from the dialog so the ordering of prompt, force-close and focus can be tested with a stubbed bridge.

/** What the flow needs of the control that started the close; a real element satisfies it. */
export interface FocusTarget {
  readonly isConnected: boolean
  focus(): void
}

export interface CloseState {
  /** The tab the prompt is asking about; `null` while no prompt is open. */
  pending: TabInfo | null
  busy: boolean
  error: string | null
  /** Counts closes that had no prompt, so the view can rescue focus once the closed tab's controls are gone. */
  idleCloses: number
}

export interface CloseControllerDeps {
  api: Pick<TerminalApi, 'close'>
  removeTab(tabId: string): void
  /** Where the keyboard goes when the control that started the close no longer exists. */
  fallbackFocus(): void
}

export interface CloseController {
  getState(): CloseState
  subscribe(listener: () => void): () => void
  /** Closes now, or opens the prompt when the shell has a running job. `invoker` is given the keyboard back on cancel. */
  requestClose(tab: TabInfo, invoker?: FocusTarget | null): Promise<void>
  /** Force-closes the tab the prompt asks about. */
  confirm(): Promise<void>
  cancel(): void
  /** Called once the prompt is gone, whichever way it closed: the invoker if it survived, else the fallback. */
  restoreFocus(): void
}

const INITIAL: CloseState = { pending: null, busy: false, error: null, idleCloses: 0 }

export function createCloseController(deps: CloseControllerDeps): CloseController {
  let state = INITIAL
  let invoker: FocusTarget | null = null
  const listeners = new Set<() => void>()

  const update = (patch: Partial<CloseState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const run = async (tab: TabInfo, force: boolean): Promise<void> => {
    update({ busy: true, error: null })
    try {
      const outcome = await closeTab(deps.api, tab, force)
      if (outcome.kind === 'closed') {
        // The invoker was this tab's own control and goes with it; it cannot take focus back.
        invoker = null
        deps.removeTab(tab.id)
        update({ pending: null, ...(force ? {} : { idleCloses: state.idleCloses + 1 }) })
      } else if (outcome.kind === 'confirm') {
        update({ pending: tab })
      } else {
        update({ error: outcome.message })
      }
    } finally {
      update({ busy: false })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    requestClose(tab, from = null) {
      invoker = from
      return run(tab, false)
    },
    confirm() {
      return state.pending ? run(state.pending, true) : Promise.resolve()
    },
    cancel() {
      update({ pending: null, error: null })
    },
    restoreFocus() {
      const target = invoker
      invoker = null
      if (target?.isConnected) target.focus()
      else deps.fallbackFocus()
    }
  }
}
