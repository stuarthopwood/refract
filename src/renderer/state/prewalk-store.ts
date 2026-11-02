import { create } from 'zustand'

/** What OMP last said about prewalk for a Session; `unknown` until it says anything (#695). */
export type PrewalkState = 'armed' | 'off' | 'unknown'

interface PrewalkStore {
  bySession: Record<string, PrewalkState>
  apply(sessionId: string, state: PrewalkState): void
}

export const usePrewalkStore = create<PrewalkStore>((set, get) => ({
  bySession: {},
  apply: (sessionId, state) => set({ bySession: { ...get().bySession, [sessionId]: state } })
}))
