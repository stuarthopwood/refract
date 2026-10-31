import { create } from 'zustand'

interface AlarmFiredState {
  firedIds: ReadonlySet<string>
  // Ids seen armed last time; kept here so a remounted clock still detects a fire.
  armedIds: ReadonlySet<string>
  sync(alarms: readonly { id: string; active: boolean }[]): void
  dismiss(id: string): void
}

/** Fired-alarm marks outlive the clock chip, which unmounts when the readout is hidden. */
export const useAlarmFiredStore = create<AlarmFiredState>((set) => ({
  firedIds: new Set(),
  armedIds: new Set(),
  sync: (alarms) =>
    set((s) => {
      const inactive = new Set(alarms.filter((a) => !a.active).map((a) => a.id))
      const armedIds = new Set(alarms.filter((a) => a.active).map((a) => a.id))
      const next = new Set([...s.firedIds, ...[...s.armedIds].filter((id) => inactive.has(id))].filter((id) => inactive.has(id)))
      const same = next.size === s.firedIds.size && [...next].every((id) => s.firedIds.has(id))
      return { armedIds, firedIds: same ? s.firedIds : next }
    }),
  dismiss: (id) =>
    set((s) => {
      const next = new Set(s.firedIds)
      next.delete(id)
      return { firedIds: next }
    })
}))
