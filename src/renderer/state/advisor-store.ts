import { create } from 'zustand'

// Advisor chip state is per Session, not per Conversation: one long-lived omp process spans them (#937).
interface AdvisorState {
  bySession: Record<string, boolean>
  reset(sessionId: string, advisorOn: boolean): void
  applyAdvisorOn(sessionId: string, advisorOn: boolean): void
}

export const useAdvisorStore = create<AdvisorState>((set, get) => ({
  bySession: {},
  reset: (sessionId, advisorOn) => set({ bySession: { ...get().bySession, [sessionId]: advisorOn } }),
  applyAdvisorOn: (sessionId, advisorOn) => set({ bySession: { ...get().bySession, [sessionId]: advisorOn } })
}))
