import { create } from 'zustand'
import type { Check } from '../../shared/ipc'

interface HealthState {
  /** The omp version check's result, persisted beyond Readiness.tsx's own lifecycle (that
   * component unmounts for good once `ready && hasRepositories`, dropping whatever it knew
   * locally). `ok: true, warning: true` is the only state worth surfacing here -- a hard
   * failure already blocks the Readiness screen itself and can't be reached past it. */
  ompVersionWarning: Check | null
  setOmpCheck(check: Check): void
}

// StatusBar.tsx's persistent notice for an omp version outside the specifically verified
// 18.4.x/18.5.x range (readiness.ts): Readiness.tsx's own screen disappears for good once a
// repository exists, so without this store a later omp update updating 18.x.y mid-session would
// never be visible anywhere again until the user manually re-opens Settings' Health check.
export const useHealthStore = create<HealthState>((set) => ({
  ompVersionWarning: null,
  setOmpCheck: (check) => set({ ompVersionWarning: check.ok && check.warning ? check : null })
}))
