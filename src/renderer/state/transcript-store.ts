import { create } from 'zustand'
import type { TranscriptOp } from '../../shared/ipc'
import type { TranscriptItem } from '../../shared/model'

interface SessionTranscript {
  items: TranscriptItem[]
  /** Wall-clock arrival time of each item that arrived as a live `upsert` patch during this app
   * run, keyed by item id (T076's turn-total-time line); a `reset` (full history load, e.g. a
   * restart or Session switch) clears it, since those items' own real timestamps may be far in
   * the past and "now" would show a nonsensical elapsed time -- that is also exactly the
   * "reopened Conversation with no usable timing" case the turn-total line is required to omit. */
  receivedAt: Record<string, number>
}

interface TranscriptState {
  bySession: Record<string, SessionTranscript>
  reset(sessionId: string, items: TranscriptItem[]): void
  applyOps(sessionId: string, ops: TranscriptOp[]): void
}

// Stable reference for a Session with no transcript entry yet, so a selector never returns a
// fresh object on every call (same pattern as queue-store's EMPTY_QUEUE).
export const EMPTY_TRANSCRIPT: SessionTranscript = { items: [], receivedAt: {} }

// Spec 005 (research.md Decision 1): generalised from one `{ sessionId, items }` pair (only one
// pane could ever be visible before this spec) to per-session, the same shape queue-store.ts
// already established -- each pane now keeps its own Session's transcript independently, so a
// patch for one pane's Session can never be dropped or clobber the other pane's own slot.
// `reset` comes from `sessions.open`'s snapshot (ChatPane.tsx's `applySnapshot`); `applyOps` folds
// the coalesced `transcript:patch` stream on top, per Session.
export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  bySession: {},
  reset: (sessionId, items) => set({ bySession: { ...get().bySession, [sessionId]: { items, receivedAt: {} } } }),
  applyOps: (sessionId, ops) => {
    const current = get().bySession[sessionId] ?? EMPTY_TRANSCRIPT
    let items = current.items
    let receivedAt = current.receivedAt
    for (const op of ops) {
      if (op.op === 'reset') {
        items = op.items
        receivedAt = {}
        continue
      }
      const index = items.findIndex((item) => item.id === op.item.id)
      items = index === -1 ? [...items, op.item] : items.map((item, i) => (i === index ? op.item : item))
      receivedAt = { ...receivedAt, [op.item.id]: Date.now() }
    }
    set({ bySession: { ...get().bySession, [sessionId]: { items, receivedAt } } })
  }
}))
