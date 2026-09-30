import { create } from 'zustand'
import type { TranscriptOp } from '../../shared/ipc'
import type { TranscriptItem } from '../../shared/model'

interface TranscriptState {
  sessionId: string | null
  items: TranscriptItem[]
  reset(sessionId: string, items: TranscriptItem[]): void
  applyOps(sessionId: string, ops: TranscriptOp[]): void
}

// The transcript of the visible Session only (contracts/ipc.md: `transcript:patch` is sent only
// for the Session the user is viewing). Switching sessions calls `reset` from `sessions.open`'s
// snapshot; `applyOps` folds the coalesced patch stream on top.
export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  sessionId: null,
  items: [],
  reset: (sessionId, items) => set({ sessionId, items }),
  applyOps: (sessionId, ops) => {
    const state = get()
    const isTrackedSession = sessionId === state.sessionId
    const hasReset = ops.some((op) => op.op === 'reset')
    // A patch for a session we are not tracking is only meaningful if it includes a `reset`:
    // that op is authoritative on its own (a full snapshot), so it can adopt `sessionId` even if
    // this store missed the moment that session became visible (e.g. a dropped/failed
    // `sessions.setVisible` call -- see the bug note in sessions-store.ts). A bare `upsert` has
    // no base to apply against for an untracked session, so it is dropped as before.
    if (!isTrackedSession && !hasReset) return
    let items = isTrackedSession ? state.items : []
    for (const op of ops) {
      if (op.op === 'reset') {
        items = op.items
        continue
      }
      const index = items.findIndex((item) => item.id === op.item.id)
      items = index === -1 ? [...items, op.item] : items.map((item, i) => (i === index ? op.item : item))
    }
    set({ sessionId, items })
  }
}))
