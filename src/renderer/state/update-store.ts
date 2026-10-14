import { create } from 'zustand'
import type { UpdateState } from '../../shared/ipc'

interface UpdateStoreState {
  /** `null` only until the very first `updates.getState()` load resolves (or fails) --
   * thereafter always a real `UpdateState`, same `idle`-by-default shape the Rust/Electron
   * store itself persists. Drives the status bar's update badge (issue #794, spec 006). */
  state: UpdateState | null
  setState(state: UpdateState): void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: null,
  setState: (state) => set({ state })
}))
