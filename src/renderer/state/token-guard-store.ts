import { create } from 'zustand'
import { toast } from 'sonner'
import type { Result } from '../../shared/ipc'
import type { TokenGuardLaunchWarning, TokenGuardMigration, TokenGuardSnapshot, TokenGuardTrigger } from '../../shared/tokenGuard'
import type { TokenGuardValues } from '../../shared/tokenGuard'

const MIGRATION_POLL_MS = 1500

// #1767: the token guard values live in OMP's global config; this store mirrors them for Settings
// > Advanced. A change reaches a running Session only for the keys marked `live`.
interface TokenGuardState {
  values: TokenGuardValues
  defaults: TokenGuardValues
  loaded: boolean
  migration: TokenGuardMigration | null
  effectiveTriggers: TokenGuardTrigger[]
  projectOverrides: string[]
  /** The last Settings write's best-effort failures (the value was saved); a read leaves them alone. */
  warnings: string[]
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
  // Several Settings rows call `load` on mount; one poll chain serves them all.
  let pollScheduled = false
  const apply = (result: Result<TokenGuardSnapshot>, write = false): boolean => {
    if (result.ok) {
      set({
        values: result.value.values,
        defaults: result.value.defaults,
        migration: result.value.migration,
        effectiveTriggers: result.value.effectiveTriggers,
        projectOverrides: result.value.projectOverrides,
        ...(write ? { warnings: result.value.warnings } : {}),
        loaded: true,
        error: null
      })
    } else {
      set({ error: result.error.message, ...(write ? { warnings: [] } : {}) })
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
    warnings: [],
    error: null,
    load: async (id) => {
      repositoryId = id
      const ok = apply(await window.refract.tokenGuard.get(id))
      // The migration runs in the background; its backup notice and the OMP values arrive on a later read.
      // A failed read ends the chain, so an erroring backend is not hammered every poll.
      if (ok && get().migration?.status === 'pending' && !pollScheduled) {
        pollScheduled = true
        setTimeout(() => {
          pollScheduled = false
          void get().load(repositoryId)
        }, MIGRATION_POLL_MS)
      }
    },
    set: async (key, value) => apply(await window.refract.tokenGuard.set(key, value, repositoryId), true),
    reset: async (key) => void apply(await window.refract.tokenGuard.reset(key, repositoryId), true),
    resetAll: async () => void apply(await window.refract.tokenGuard.resetAll(repositoryId), true),
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
