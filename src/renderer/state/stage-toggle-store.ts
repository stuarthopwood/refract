import { create } from 'zustand'

// Issue #991 follow-up 2 (Low, deferred from the #941 gate, PR #979): `StageGroupRow`'s and
// `SubagentChainRow`'s own manual-toggle flag used to live in a plain `useRef`/`useState` pair,
// so a toggle a user made was forgotten the instant either row remounted -- a session switch
// returns to a DIFFERENT `Transcript` mount entirely, and `SubagentChainRow` itself unmounts
// outright (`if (stages.length < 2) return null`) whenever a turn's own Stage count drops back
// below 2, then remounts fresh (with every hook reset) if it rises again. Keyed by session +
// row id (a Stage's own `group.id`, or `chain:<first stage id>` for the per-turn chain row,
// since that has no id of its own) so a toggle survives either kind of remount. Non-persisted,
// in-memory only -- same convention as `alert-dismiss-store.ts`: reset only by a full app
// restart, never written to `settings.json`/disk.
interface StageToggleEntry {
  open: boolean
  userToggled: boolean
}

interface StageToggleState {
  byKey: Record<string, StageToggleEntry>
  setToggle(key: string, open: boolean, userToggled: boolean): void
}

export const useStageToggleStore = create<StageToggleState>((set, get) => ({
  byKey: {},
  setToggle: (key, open, userToggled) => set({ byKey: { ...get().byKey, [key]: { open, userToggled } } })
}))

export function stageToggleKey(sessionId: string | null, rowId: string): string {
  return `${sessionId ?? 'none'}:${rowId}`
}
