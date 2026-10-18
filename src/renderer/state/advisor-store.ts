import { create } from 'zustand'

// Issue #937: the composer status line's Advisor chip on/off state, per Session (mirrors
// readout-store.ts's own per-session shape). Seeded from `SessionSnapshot.advisorOn`
// (`applySnapshot.ts`), kept live by `advisor:update` (`init-stores.ts`). Session-scoped, not
// Conversation-scoped (`/advisor on|off` persists across a Session's own Conversations, since
// one Session has one long-lived omp process) -- unlike `readout-store.ts`'s `contextUsage`/
// `todoProgress`, nothing here resets on a Conversation switch, so there is no
// `conversations.startNew`/`.open` hook for this store.
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
