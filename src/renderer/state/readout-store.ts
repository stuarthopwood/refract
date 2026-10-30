import { create } from 'zustand'
import type { SessionReadout } from '../../shared/model'
import type { SubagentSummary } from '../../shared/model'
import { useSubagentPanelStore } from './subagent-store'


export const EMPTY_READOUT: SessionReadout = {
  changes: null,
  contextUsage: null,
  turnTime: null,
  pullRequest: null,
  subagentCount: null,
  todoTree: null,
  todoPhases: null
}

interface SessionReadoutEntry {
  readout: SessionReadout
  subagents: SubagentSummary[]
}

// Stable reference for a Session with no readout entry yet, so a selector never returns a fresh
// object on every call (same pattern as queue-store's EMPTY_QUEUE).
export const EMPTY_READOUT_ENTRY: SessionReadoutEntry = { readout: EMPTY_READOUT, subagents: [] }

interface ReadoutState {
  bySession: Record<string, SessionReadoutEntry>
  reset(sessionId: string, readout: SessionReadout, subagents: SubagentSummary[]): void
  applyReadout(sessionId: string, readout: SessionReadout): void
  applySubagents(sessionId: string, subagents: SubagentSummary[]): void
}

export const useReadoutStore = create<ReadoutState>((set, get) => ({
  bySession: {},
  reset: (sessionId, readout, subagents) =>
    set({ bySession: { ...get().bySession, [sessionId]: { readout, subagents } } }),
  applyReadout: (sessionId, readout) => {
    const current = get().bySession[sessionId] ?? EMPTY_READOUT_ENTRY
    set({ bySession: { ...get().bySession, [sessionId]: { readout, subagents: current.subagents } } })
  },
  applySubagents: (sessionId, subagents) => {
    const current = get().bySession[sessionId] ?? EMPTY_READOUT_ENTRY
    const hadSubagents = current.subagents.length > 0
    set({ bySession: { ...get().bySession, [sessionId]: { readout: current.readout, subagents } } })
    if (hadSubagents && subagents.length === 0) {
      useSubagentPanelStore.getState().resetForNewTurn(sessionId)
    }
  }
}))
