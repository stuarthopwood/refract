import { create } from 'zustand'

interface AlarmFiredState {
  firedIds: ReadonlySet<string>
  // Ids seen armed last time; kept here so a remounted clock still detects a fire.
  armedIds: ReadonlySet<string>
  // Fire events whose inactive snapshot has not arrived yet (the event is emitted before the settings change).
  pendingIds: ReadonlySet<string>
  sync(alarms: readonly { id: string; active: boolean }[]): void
  markFired(id: string, alarms: readonly { id: string; active: boolean }[]): void
  dismiss(id: string): void
}

/** Fired-alarm marks outlive the clock chip, which unmounts when the readout is hidden. */
export const useAlarmFiredStore = create<AlarmFiredState>((set, get) => ({
  firedIds: new Set(),
  armedIds: new Set(),
  pendingIds: new Set(),
  sync: (alarms) =>
    set((s) => {
      const inactive = new Set(alarms.filter((a) => !a.active).map((a) => a.id))
      const present = new Set(alarms.map((a) => a.id))
      const armedIds = new Set(alarms.filter((a) => a.active).map((a) => a.id))
      const promoted = [...s.armedIds, ...s.pendingIds].filter((id) => inactive.has(id))
      const next = new Set([...s.firedIds, ...promoted].filter((id) => inactive.has(id)))
      const pendingIds = new Set([...s.pendingIds].filter((id) => present.has(id) && !inactive.has(id)))
      const same = next.size === s.firedIds.size && [...next].every((id) => s.firedIds.has(id))
      return { armedIds, pendingIds, firedIds: same ? s.firedIds : next }
    }),
  markFired: (id, alarms) => {
    set((s) => ({ pendingIds: new Set([...s.pendingIds, id]) }))
    get().sync(alarms)
  },
  dismiss: (id) =>
    set((s) => {
      const next = new Set(s.firedIds)
      next.delete(id)
      return { firedIds: next }
    })
}))
