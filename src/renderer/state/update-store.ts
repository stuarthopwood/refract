import { create } from 'zustand'
import type { UpdateState } from '../../shared/updates'

interface UpdateStoreState {
  /** `null` only until the very first `updates.getState()` load resolves (or fails) --
   * thereafter always a real `UpdateState`, same `idle`-by-default shape the Rust/Electron
   * store itself persists. Drives the profile avatar's update dot and the menu's update item (issues #794, #137). */
  state: UpdateState | null
  setState(state: UpdateState): void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: null,
  setState: (state) => set({ state })
}))
