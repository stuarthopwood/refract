import { create } from 'zustand'
import type { SessionSnapshot, SessionStatusEvent, SessionSummary } from '../../shared/ipc'
import { notify } from './notify'

interface SessionsState {
  sessions: SessionSummary[]
  visibleSessionId: string | null
  /** Session ids with an `open()` call in flight (bug report point 4): lets a row/ChatPane show
   * "Starting the agent..." feedback and ignore a second click while the first is still opening. */
  openingIds: Set<string>
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

// Guards `open()` against out-of-order completion: only the most recently requested `open()`
// call may apply its snapshot and steal visibility back (bug report point 4 -- a slow `open()`
// for a Session the user already switched away from must not clobber the one they switched to).
// Module-level, not store state, because it is an internal sequencing detail no component reads.
let latestOpenToken = 0

// Callers that arrive while an `open(id)` is already in flight JOIN that call instead of getting
// `null`: without this, A -> B -> A (A cold-starting) left BOTH the second `open(A)` (returns
// null because `openingIds.has(id)`) and the first (resolves with a now-stale token, also
// returns null) applying no snapshot at all, so ChatPane's stop-banner/`chat.commands` fetch and
// MessageInput's send-after-open were silently skipped.
const openPromises = new Map<string, Promise<SessionSnapshot | null>>()

// The session list (contracts/ipc.md "Sessions") plus which Session the chat pane is showing.
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  visibleSessionId: null,
  openingIds: new Set(),
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
  // The one place that tells main which Session is visible (contracts/ipc.md `sessions.setVisible`),
  // so every caller (here, `open` below, and `onUiOpenSession` in init-stores.ts) goes through it.
  setVisibleSessionId: (id) => {
    set({ visibleSessionId: id })
    window.pinion.sessions.setVisible(id).then(
      (result) => {
        if (!result.ok) console.error('sessions.setVisible failed', result.error)
      },
      (err: unknown) => console.error('sessions.setVisible threw', err)
    )
  },
  open: (id) => {
    const existing = openPromises.get(id)
    if (existing) return existing
    const token = ++latestOpenToken
    const previousVisibleId = get().visibleSessionId
    set({ openingIds: new Set(get().openingIds).add(id) })
    // Flip visibility together with `openingIds`, before the IPC resolves (bug report point 5):
    // main's visible Session (set by the `sessions.setVisible` call inside `setVisibleSessionId`)
    // and the renderer's own `visibleSessionId` must never disagree, and "Starting the agent..."
    // (gated on `openingIds.has(visibleSessionId)`) must be visible for the whole open, not just
    // after it resolves.
    get().setVisibleSessionId(id)
    const promise = (async () => {
      try {
        const result = await window.pinion.sessions.open(id)
        if (!result.ok) {
          notify(result.error)
          // Revert the optimistic flip -- but only if nothing newer already took over visibility.
          if (get().visibleSessionId === id) get().setVisibleSessionId(previousVisibleId)
          return null
        }
        // A newer open() (for a *different* id) superseded this one: only discard the snapshot
        // when `id` is no longer the visible Session -- if the user came back to `id` (A -> B ->
        // A), it is visible again and must still receive its snapshot.
        if (token !== latestOpenToken && get().visibleSessionId !== id) return null
        return result.value
      } finally {
        const openingIds = new Set(get().openingIds)
        openingIds.delete(id)
        set({ openingIds })
        openPromises.delete(id)
      }
    })()
    openPromises.set(id, promise)
    return promise
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
