import { create } from 'zustand'
import type { LowMemoryWarning } from '../../shared/ipc'

interface MemoryState {
  warning: LowMemoryWarning | null
  setWarning(warning: LowMemoryWarning): void
}

// The status bar's low-memory notice (contracts/ipc.md `memory:warning`); never stops an agent
// automatically (FR-037), so this store only ever surfaces the latest warning state.
export const useMemoryStore = create<MemoryState>((set) => ({
  warning: null,
  setWarning: (warning) => set({ warning: warning.low ? warning : null })
}))
