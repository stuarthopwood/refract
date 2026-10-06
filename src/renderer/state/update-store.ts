import { create } from 'zustand'
import type { UpdateState } from '../../shared/ipc'

const DEFAULT_UPDATE_STATE: UpdateState = { version: 1, phase: 'idle' }

interface UpdateStoreState {
  state: UpdateState
  setState(state: UpdateState): void
}

// Spec 006 contracts/ipc.md `updates:state-changed`: the status bar's update badge (research.md
// decision 11; spec 004/008 will each add their own permanent entry later against this same
// store and API) -- persists beyond any one component's lifecycle, the same reason
// `health-store.ts`'s `ompVersionWarning` exists apart from `Readiness.tsx`'s own local state.
export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: DEFAULT_UPDATE_STATE,
  setState: (state) => set({ state })
}))

export { DEFAULT_UPDATE_STATE }
