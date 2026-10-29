import { create } from 'zustand'

// Issue #561: each Session's degraded-only health (slow agent RPC, high agent memory), kept live by
// `session:health` (`init-stores.ts`). A Session with no entry, or an entry with both fields null,
// is healthy and shows nothing on the Status line.
export interface SessionHealth {
  rpcSlowMs: number | null
  agentMemoryBytes: number | null
}

interface SessionHealthState {
  bySession: Record<string, SessionHealth>
  apply(health: SessionHealth & { sessionId: string }): void
}

export const useSessionHealthStore = create<SessionHealthState>((set, get) => ({
  bySession: {},
  apply: ({ sessionId, rpcSlowMs, agentMemoryBytes }) => {
    if (rpcSlowMs === null && agentMemoryBytes === null) {
      if (!(sessionId in get().bySession)) return
      const { [sessionId]: _healthy, ...rest } = get().bySession
      set({ bySession: rest })
      return
    }
    set({ bySession: { ...get().bySession, [sessionId]: { rpcSlowMs, agentMemoryBytes } } })
  }
}))
