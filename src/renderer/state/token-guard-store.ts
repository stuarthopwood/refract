import { create } from 'zustand'
import { toast } from 'sonner'
import type { Result } from '../../shared/ipc'
import type { TokenGuardLaunchWarning, TokenGuardSnapshot } from '../../shared/tokenGuard'
import type { TokenGuardValues } from '../../shared/tokenGuard'

// #1212: the Refract-owned `omp` launch overlay values behind Settings > OMP. A change here
// applies to the next launched Session only.
interface TokenGuardState {
  values: TokenGuardValues
  defaults: TokenGuardValues
  loaded: boolean
  /** True once an upgrade dropped stored token thresholds; the backend keeps reporting it until `dismissThresholdsReset()`. */
  thresholdsReset: boolean
  error: string | null
  load(): Promise<void>
  set(key: string, value: unknown): Promise<boolean>
  reset(key: string): Promise<void>
  resetAll(): Promise<void>
  dismissThresholdsReset(): void
}

export const useTokenGuardStore = create<TokenGuardState>((set) => {
  const apply = (result: Result<TokenGuardSnapshot>): boolean => {
    if (result.ok) {
      set((state) => ({
        values: result.value.values,
        defaults: result.value.defaults,
        thresholdsReset: state.thresholdsReset || result.value.thresholdsReset === true,
        loaded: true,
        error: null
      }))
    } else {
      set({ error: result.error.message })
    }
    return result.ok
  }
  return {
    values: {},
    defaults: {},
    loaded: false,
    thresholdsReset: false,
    error: null,
    load: async () => void apply(await window.refract.tokenGuard.get()),
    set: async (key, value) => apply(await window.refract.tokenGuard.set(key, value)),
    reset: async (key) => void apply(await window.refract.tokenGuard.reset(key)),
    resetAll: async () => void apply(await window.refract.tokenGuard.resetAll()),
    dismissThresholdsReset: () => {
      set({ thresholdsReset: false })
      // A failed write means the notice shows again the next time Settings loads.
      void window.refract.tokenGuard.dismissThresholdsReset().catch(() => {})
    }
  }
})

/** The "Start in plan mode" setting (`plan.defaultOnStartup`), for the composer working-mode menu (#433). */
export function useStartInPlanMode(): boolean {
  return useTokenGuardStore((s) => s.values['plan.defaultOnStartup'] === true)
}

export function showTokenGuardWarning(warning: TokenGuardLaunchWarning): void {
  toast.warning('Refract could not apply its token-saving settings to this Session.', {
    id: `token-guard-${warning.sessionId ?? 'launch'}`,
    description: warning.reason,
    duration: Infinity,
    closeButton: true
  })
}
