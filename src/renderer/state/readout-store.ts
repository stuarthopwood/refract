import { create } from 'zustand'
import type { SessionReadout } from '../../shared/model'
import type { SubagentSummary } from '../../shared/model'
import { useSubagentPanelStore } from './subagent-store'

// Spec 004's chip row and Subagents data, per Session (contracts/ipc.md: `readout:update` and
// `subagents:update` each carry their own `sessionId`). Switching sessions calls `reset` from
// `sessions.open`'s snapshot (ChatPane.tsx's `applySnapshot`); live events fold on top, same
// pattern as transcript-store.ts.
//
// Spec 005 convergence (tasks.md T030): generalised from a single `{ sessionId, readout,
// subagents }` triple (spec 004 predates this spec's split) to per-session storage, the same
// shape queue-store.ts/pending-requests-store.ts/commands-store.ts already use -- each pane now
// keeps its own Session's chip-row and Subagents data independent of the other pane.

export const EMPTY_READOUT: SessionReadout = {
  changes: null,
  contextUsage: null,
  turnTime: null,
  pullRequest: null,
  subagentCount: null,
  todoProgress: null,
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
