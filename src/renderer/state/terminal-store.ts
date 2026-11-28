import { create } from 'zustand'
import type { TabInfo, TerminalTabStateEvent } from '../../shared/ipc-terminal'

// Tab metadata per Session, fed by `terminal.list` and `terminal:tab-state`. Output never lands here: it streams
// from Rust straight into the one live xterm instance, so a flooding shell cannot re-render the panel. (spec 144, FR-010)

export interface SessionTerminals {
  tabs: TabInfo[]
  activeTabId: string | null
  /** False until the first `terminal.list` answers, so "no tabs yet" is never shown while loading. */
  loaded: boolean
  /** The `terminal.list` or `terminal.create` failure the panel shows; cleared by the next success. */
  error: string | null
}

interface TerminalState {
  bySession: Record<string, SessionTerminals>
  /** Loads the Session's tabs once; a second call while loaded or in flight is a no-op unless `force`. */
  load: (sessionId: string, force?: boolean) => Promise<void>
  /** Creates a tab through Rust and makes it active; the tab list is only ever what Rust returned. */
  create: (sessionId: string, cols: number, rows: number) => Promise<TabInfo | null>
  applyTabState: (event: TerminalTabStateEvent) => void
  setActive: (sessionId: string, tabId: string) => void
  removeTab: (sessionId: string, tabId: string) => void
  /** Drops the state of Sessions that are gone. */
  pruneSessions: (keepIds: ReadonlySet<string>) => void
}

const EMPTY: SessionTerminals = { tabs: [], activeTabId: null, loaded: false, error: null }

/** The state for a Session, or the shared empty state before anything arrived. */
export const selectSessionTerminals = (state: Pick<TerminalState, 'bySession'>, sessionId: string | null): SessionTerminals =>
  (sessionId === null ? undefined : state.bySession[sessionId]) ?? EMPTY

/** The tab the panel shows: the chosen one if it still exists, else the first. */
export function activeTab(session: SessionTerminals): TabInfo | null {
  return session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null
}

const byOrder = (a: TabInfo, b: TabInfo): number => a.order - b.order

function upsert(tabs: TabInfo[], tab: TabInfo): TabInfo[] {
  const index = tabs.findIndex((held) => held.id === tab.id)
  const next = index < 0 ? [...tabs, tab] : tabs.map((held, i) => (i === index ? tab : held))
  return next.sort(byOrder)
}

/** Sessions with a `terminal.list` in flight, so a remount does not issue a second one. */
const loading = new Set<string>()

export const useTerminalStore = create<TerminalState>((set, get) => {
  const patch = (sessionId: string, change: (current: SessionTerminals) => Partial<SessionTerminals>): void =>
    set((state) => {
      const current = selectSessionTerminals(state, sessionId)
      return { bySession: { ...state.bySession, [sessionId]: { ...current, ...change(current) } } }
    })

  return {
    bySession: {},

    load: async (sessionId, force = false) => {
      if (loading.has(sessionId)) return
      if (!force && selectSessionTerminals(get(), sessionId).loaded) return
      loading.add(sessionId)
      try {
        const result = await window.refract.terminal.list(sessionId)
        if (!result.ok) {
          patch(sessionId, () => ({ loaded: true, error: result.error.message }))
          return
        }
        // Local choice wins over Rust's saved active tab while that tab is still there (a forced reload keeps the view).
        patch(sessionId, (current) => ({
          tabs: [...result.value.tabs].sort(byOrder),
          activeTabId: result.value.tabs.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : result.value.activeTabId,
          loaded: true,
          error: null
        }))
      } catch (error) {
        patch(sessionId, () => ({ loaded: true, error: error instanceof Error ? error.message : 'Could not load terminals' }))
      } finally {
        loading.delete(sessionId)
      }
    },

    create: async (sessionId, cols, rows) => {
      const result = await window.refract.terminal.create(sessionId, cols, rows)
      if (!result.ok) {
        patch(sessionId, () => ({ error: result.error.message }))
        return null
      }
      const tab = result.value
      patch(sessionId, (current) => ({ tabs: upsert(current.tabs, tab), activeTabId: tab.id, error: null }))
      return tab
    },

    applyTabState: ({ sessionId, tab }) => {
      patch(sessionId, (current) => ({ tabs: upsert(current.tabs, tab) }))
    },

    setActive: (sessionId, tabId) => {
      if (selectSessionTerminals(get(), sessionId).activeTabId === tabId) return
      patch(sessionId, () => ({ activeTabId: tabId }))
    },

    removeTab: (sessionId, tabId) => {
      patch(sessionId, (current) => {
        const tabs = current.tabs.filter((tab) => tab.id !== tabId)
        if (tabs.length === current.tabs.length) return {}
        // Closing the shown tab lands on its neighbour rather than jumping to the first.
        const closedAt = current.tabs.findIndex((tab) => tab.id === tabId)
        const activeTabId = current.activeTabId === tabId ? (tabs[Math.min(closedAt, tabs.length - 1)]?.id ?? null) : current.activeTabId
        return { tabs, activeTabId }
      })
    },

    pruneSessions: (keepIds) => {
      const bySession = Object.fromEntries(Object.entries(get().bySession).filter(([id]) => keepIds.has(id)))
      if (Object.keys(bySession).length !== Object.keys(get().bySession).length) set({ bySession })
    }
  }
})
