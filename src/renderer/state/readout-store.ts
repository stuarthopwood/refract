import { create } from 'zustand'
import type { SessionReadout } from '../../shared/model'
import type { SubagentSummary } from '../../shared/model'
import { useSubagentPanelStore } from './subagent-store'

// The chip row's live data for the visible Session only (contracts/ipc.md: `readout:update` and
// `subagents:update` are both sent only for the Session the user is viewing). Switching sessions
// calls `reset` from `sessions.open`'s snapshot (ChatPane.tsx's `applySnapshot`); live events fold
// on top, same pattern as transcript-store.ts.

export const EMPTY_READOUT: SessionReadout = {
  changes: null,
  contextUsage: null,
  turnTime: null,
  pullRequest: null,
  subagentCount: null,
  todoProgress: null
}

interface ReadoutState {
  sessionId: string | null
  readout: SessionReadout
  subagents: SubagentSummary[]
  reset(sessionId: string, readout: SessionReadout, subagents: SubagentSummary[]): void
  applyReadout(sessionId: string, readout: SessionReadout): void
  applySubagents(sessionId: string, subagents: SubagentSummary[]): void
}

export const useReadoutStore = create<ReadoutState>((set, get) => ({
  sessionId: null,
  readout: EMPTY_READOUT,
  subagents: [],
  reset: (sessionId, readout, subagents) => set({ sessionId, readout, subagents }),
  applyReadout: (sessionId, readout) => {
    if (sessionId !== get().sessionId) return
    set({ readout })
  },
  applySubagents: (sessionId, subagents) => {
    if (sessionId !== get().sessionId) return
    const hadSubagents = get().subagents.length > 0
    set({ subagents })
    // Spec 004 remediation (HIGH, code-reviewer): `agent_start` is the only place SessionAgent
    // ever resets `runtime.subagents` back to `[]` (FR-007's own count persists after a turn
    // settles, so nothing else ever empties it) -- a non-empty -> empty transition here is that
    // signal, reliable enough to clear the Subagent panel's own per-turn selection and stream
    // cache (or close it outright) before a later turn can reuse a subagent name and silently
    // merge its live stream onto the one still cached from the turn that just ended.
    if (hadSubagents && subagents.length === 0) {
      useSubagentPanelStore.getState().resetForNewTurn(sessionId)
    }
  }
}))
