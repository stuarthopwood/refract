import { create } from 'zustand'
import { toast } from 'sonner'
import type { Result } from '../../shared/ipc'
import type { TokenGuardLaunchWarning, TokenGuardMigration, TokenGuardSnapshot, TokenGuardTrigger } from '../../shared/tokenGuard'
import type { TokenGuardValues } from '../../shared/tokenGuard'

// #1767: the token guard values live in OMP's global config; this store mirrors them for Settings
// > Advanced. A change reaches a running Session only for the keys marked `live`.
interface TokenGuardState {
  values: TokenGuardValues
  defaults: TokenGuardValues
  loaded: boolean
  migration: TokenGuardMigration | null
  effectiveTriggers: TokenGuardTrigger[]
  projectOverrides: string[]
  error: string | null
  /** Loads the snapshot; `repositoryId` is the open Project whose `.omp/config.yml` is checked for overrides. */
  load(repositoryId?: string): Promise<void>
  set(key: string, value: unknown): Promise<boolean>
  reset(key: string): Promise<void>
  resetAll(): Promise<void>
  dismissMigrationNotice(): void
}

export const useTokenGuardStore = create<TokenGuardState>((set, get) => {
  // The Project the last `load` named; later writes pass it so their snapshot keeps the overrides.
  let repositoryId: string | undefined
  const apply = (result: Result<TokenGuardSnapshot>): boolean => {
    if (result.ok) {
      set({
        values: result.value.values,
        defaults: result.value.defaults,
        migration: result.value.migration,
        effectiveTriggers: result.value.effectiveTriggers,
        projectOverrides: result.value.projectOverrides,
        loaded: true,
        error: null
      })
    } else {
      set({ error: result.error.message })
    }
    return result.ok
  }
  return {
    values: {},
    defaults: {},
    loaded: false,
    migration: null,
    effectiveTriggers: [],
    projectOverrides: [],
    error: null,
    load: async (id) => {
      repositoryId = id
      apply(await window.refract.tokenGuard.get(id))
    },
    set: async (key, value) => apply(await window.refract.tokenGuard.set(key, value, repositoryId)),
    reset: async (key) => void apply(await window.refract.tokenGuard.reset(key, repositoryId)),
    resetAll: async () => void apply(await window.refract.tokenGuard.resetAll(repositoryId)),
    dismissMigrationNotice: () => {
      const { migration } = get()
      if (migration) set({ migration: { ...migration, backupPath: undefined } })
      // A failed write means the notice shows again the next time Settings loads.
      void window.refract.tokenGuard.dismissMigrationNotice().catch(() => {})
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
