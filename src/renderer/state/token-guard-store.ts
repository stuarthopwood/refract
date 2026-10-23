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
  error: string | null
  load(): Promise<void>
  set(key: string, value: unknown): Promise<void>
  reset(key: string): Promise<void>
}

export const useTokenGuardStore = create<TokenGuardState>((set) => {
  const apply = (result: Result<TokenGuardSnapshot>): void => {
    if (result.ok) {
      set({ values: result.value.values, defaults: result.value.defaults, loaded: true, error: null })
    } else {
      set({ error: result.error.message })
    }
  }
  return {
    values: {},
    defaults: {},
    loaded: false,
    error: null,
    load: async () => apply(await window.refract.tokenGuard.get()),
    set: async (key, value) => apply(await window.refract.tokenGuard.set(key, value)),
    reset: async (key) => apply(await window.refract.tokenGuard.reset(key))
  }
})

export function showTokenGuardWarning(warning: TokenGuardLaunchWarning): void {
  toast.warning('Refract could not apply its token-saving settings to this Session.', {
    id: `token-guard-${warning.sessionId ?? 'launch'}`,
    description: warning.reason,
    duration: Infinity,
    closeButton: true
  })
}
