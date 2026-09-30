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
    if (sessionId !== get().sessionId) return // patch for a Session that is not visible
    let items = get().items
    for (const op of ops) {
      if (op.op === 'reset') {
        items = op.items
        continue
      }
      const index = items.findIndex((item) => item.id === op.item.id)
      items = index === -1 ? [...items, op.item] : items.map((item, i) => (i === index ? op.item : item))
    }
    set({ items })
  }
}))
