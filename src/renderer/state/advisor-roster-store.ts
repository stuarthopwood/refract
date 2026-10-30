import { create } from 'zustand'
import type { AdvisorRoster, AdvisorRosterDetected } from '../../shared/ipc-advisor-roster'

// #1409: the roster found at each Session's launch (`advisor-roster:detected`). A dismissal is
// keyed by roster path, so a later launch that finds the same file does not repeat the notice.
interface AdvisorRosterState {
  bySession: Record<string, AdvisorRoster>
  dismissed: Record<string, string>
  setDetected(payload: AdvisorRosterDetected): void
  dismiss(sessionId: string): void
}

export const useAdvisorRosterStore = create<AdvisorRosterState>((set) => ({
  bySession: {},
  dismissed: {},
  setDetected: ({ sessionId, roster }) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: roster } })),
  dismiss: (sessionId) =>
    set((s) => {
      const roster = s.bySession[sessionId]
      return roster ? { dismissed: { ...s.dismissed, [sessionId]: roster.path } } : s
    })
}))
