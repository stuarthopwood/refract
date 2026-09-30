import { create } from 'zustand'
import type { SessionSnapshot, SessionStatusEvent, SessionSummary } from '../../shared/ipc'
import { notify } from './notify'

interface SessionsState {
  sessions: SessionSummary[]
  visibleSessionId: string | null
  setSessions(sessions: SessionSummary[]): void
  applyStatus(event: SessionStatusEvent): void
  refresh(): Promise<void>
  setVisibleSessionId(id: string | null): void
  open(id: string): Promise<SessionSnapshot | null>
  rename(id: string, name: string): Promise<void>
  archive(id: string): Promise<void>
  restore(id: string): Promise<void>
  stopAgent(id: string): Promise<void>
}

// The session list (contracts/ipc.md "Sessions") plus which Session the chat pane is showing.
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  visibleSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  applyStatus: (event) =>
    set({
      sessions: get().sessions.map((session) =>
        session.id === event.sessionId
          ? { ...session, status: event.status, unread: event.unread, pendingMode: event.pendingMode }
          : session
      )
    }),
  refresh: async () => {
    const result = await window.pinion.sessions.list()
    if (result.ok) {
      set({ sessions: result.value })
    } else {
      notify(result.error)
    }
  },
  // The one place that tells main which Session is visible (contracts/ipc.md
  // `sessions.setVisible`), so every caller (here, `open` below, and `onUiOpenSession` in
  // init-stores.ts) goes through it instead of writing `visibleSessionId` directly.
  setVisibleSessionId: (id) => {
    set({ visibleSessionId: id })
    void window.pinion.sessions.setVisible(id)
  },
  open: async (id) => {
    const result = await window.pinion.sessions.open(id)
    if (!result.ok) {
      notify(result.error)
      return null
    }
    get().setVisibleSessionId(id)
    return result.value
  },
  rename: async (id, name) => {
    const result = await window.pinion.sessions.rename(id, name)
    if (!result.ok) notify(result.error)
  },
  archive: async (id) => {
    const result = await window.pinion.sessions.archive(id)
    if (!result.ok) notify(result.error)
  },
  restore: async (id) => {
    const result = await window.pinion.sessions.restore(id)
    if (!result.ok) notify(result.error)
  },
  stopAgent: async (id) => {
    const result = await window.pinion.sessions.stopAgent(id)
    if (!result.ok) notify(result.error)
  }
}))
