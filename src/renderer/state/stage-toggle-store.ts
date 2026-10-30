import { create } from 'zustand'

// Non-persisted, in-memory only (same convention as `alert-dismiss-store.ts`): reset only by a full
// app restart, never written to `settings.json`/disk. Adding a new session-delete-prune mechanism
// just for this store would be a new convention, out of scope here.
interface StageToggleState {
  bySession: Record<string, Record<string, boolean>>
  setManualOpen(sessionId: string, rowId: string, open: boolean): void
}

export const useStageToggleStore = create<StageToggleState>((set, get) => ({
  bySession: {},
  setManualOpen: (sessionId, rowId, open) => {
    const current = get().bySession[sessionId] ?? {}
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, [rowId]: open } } })
  }
}))
