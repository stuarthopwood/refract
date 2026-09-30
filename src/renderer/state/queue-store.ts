import { create } from 'zustand'

interface QueueState {
  sessionId: string | null
  followUp: string[]
  steering: string[]
  apply(sessionId: string, followUp: string[], steering: string[]): void
}

// The queued-message chips for the visible Session (contracts/ipc.md `queue:update`).
export const useQueueStore = create<QueueState>((set) => ({
  sessionId: null,
  followUp: [],
  steering: [],
  apply: (sessionId, followUp, steering) => set({ sessionId, followUp, steering })
}))
