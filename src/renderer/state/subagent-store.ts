import { create } from 'zustand'
import type { TranscriptItem } from '../../shared/model'
import type { TranscriptOp } from '../../shared/ipc'
import { notify } from './notify'

// Spec 004 FR-017 to FR-020: the Subagents panel's open/closed state and the selected subagent's
// live stream. `streams` holds every subagent's stream the panel has ever fetched this turn
// (cleared on `close`/a new turn), so re-selecting one already seen does not re-fetch.

function applyOps(items: TranscriptItem[], ops: TranscriptOp[]): TranscriptItem[] {
  let next = items
  for (const op of ops) {
    if (op.op === 'reset') {
      next = op.items
      continue
    }
    const index = next.findIndex((item) => item.id === op.item.id)
    next = index === -1 ? [...next, op.item] : next.map((item, i) => (i === index ? op.item : item))
  }
  return next
}

interface SubagentPanelState {
  open: boolean
  sessionId: string | null
  selectedId: string | null
  streams: Record<string, TranscriptItem[]>
  openPanel(sessionId: string): void
  closePanel(): void
  selectSubagent(subagentId: string): Promise<void>
  applyPatch(sessionId: string, subagentId: string, ops: TranscriptOp[]): void
  reset(): void
}

export const useSubagentPanelStore = create<SubagentPanelState>((set, get) => ({
  open: false,
  sessionId: null,
  selectedId: null,
  streams: {},
  openPanel: (sessionId) => set({ open: true, sessionId }),
  closePanel: () => {
    const { sessionId } = get()
    if (sessionId) void window.refract.chat.setVisibleSubagent(sessionId, null)
    set({ open: false, selectedId: null, streams: {} })
  },
  selectSubagent: async (subagentId) => {
    const { sessionId } = get()
    if (!sessionId) return
    set({ selectedId: subagentId })
    await window.refract.chat.setVisibleSubagent(sessionId, subagentId)
    if (get().streams[subagentId]) return // already fetched this turn
    const result = await window.refract.chat.subagentSnapshot(sessionId, subagentId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    set((state) => ({ streams: { ...state.streams, [subagentId]: result.value } }))
  },
  applyPatch: (sessionId, subagentId, ops) => {
    const state = get()
    if (sessionId !== state.sessionId || subagentId !== state.selectedId) return
    const current = state.streams[subagentId] ?? []
    set({ streams: { ...state.streams, [subagentId]: applyOps(current, ops) } })
  },
  reset: () => set({ open: false, sessionId: null, selectedId: null, streams: {} })
}))
