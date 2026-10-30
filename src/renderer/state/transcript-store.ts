import { create } from 'zustand'
import type { TranscriptOp } from '../../shared/ipc'
import type { TranscriptItem } from '../../shared/model'

interface SessionTranscript {
  items: TranscriptItem[]
  /** Arrival time of items upserted live this run (turn-total line); cleared on reset so old history shows no bogus elapsed time. */
  receivedAt: Record<string, number>
  /** Bumped only when the whole transcript is replaced (reset), never by an upsert, so scroll-landing doesn't re-fire mid-turn (#485). */
  generation: number
}

interface TranscriptState {
  bySession: Record<string, SessionTranscript>
  reset(sessionId: string, items: TranscriptItem[]): void
  applyOps(sessionId: string, ops: TranscriptOp[]): void
}

// Stable reference so selectors never return a fresh object for an unknown Session.
export const EMPTY_TRANSCRIPT: SessionTranscript = { items: [], receivedAt: {}, generation: 0 }

// Per-session slots so a patch for one pane never clobbers another's; `reset` is the snapshot, `applyOps` folds patches.
export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  bySession: {},
  reset: (sessionId, items) =>
    set({
      bySession: {
        ...get().bySession,
        [sessionId]: { items, receivedAt: {}, generation: (get().bySession[sessionId]?.generation ?? 0) + 1 }
      }
    }),
  applyOps: (sessionId, ops) => {
    const current = get().bySession[sessionId] ?? EMPTY_TRANSCRIPT
    let items = current.items
    let receivedAt = current.receivedAt
    let sawReset = false
    for (const op of ops) {
      if (op.op === 'reset') {
        items = op.items
        receivedAt = {}
        sawReset = true
        continue
      }
      const index = items.findIndex((item) => item.id === op.item.id)
      items = index === -1 ? [...items, op.item] : items.map((item, i) => (i === index ? op.item : item))
      receivedAt = { ...receivedAt, [op.item.id]: Date.now() }
    }
    set({
      bySession: {
        ...get().bySession,
        [sessionId]: { items, receivedAt, generation: sawReset ? current.generation + 1 : current.generation }
      }
    })
  }
}))
