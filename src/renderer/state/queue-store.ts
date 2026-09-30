import { create } from 'zustand'

interface SessionQueue {
  followUp: string[]
  steering: string[]
}

interface QueueState {
  bySession: Record<string, SessionQueue>
  apply(sessionId: string, followUp: string[], steering: string[]): void
}

// Stable reference for a Session with no queue entry yet, so a selector never returns a fresh
// object on every call (a fresh `{}` would break useSyncExternalStore's snapshot stability and
// cause an infinite re-render loop; same pattern as pending-requests-store's `[]` default).
export const EMPTY_QUEUE: SessionQueue = { followUp: [], steering: [] }

// The queued-message chips, keyed per Session (contracts/ipc.md `queue:update`), so a patch for a
// background Session can never clear the visible Session's chips: the old shape stored one
// `sessionId` plus one `followUp`/`steering` pair, so the last `queue:update` received for ANY
// Session silently overwrote whichever Session's chips were on screen.
export const useQueueStore = create<QueueState>((set, get) => ({
  bySession: {},
  apply: (sessionId, followUp, steering) =>
    set({ bySession: { ...get().bySession, [sessionId]: { followUp, steering } } })
}))
