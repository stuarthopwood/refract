import { create } from 'zustand'
import { toast } from 'sonner'
import type { Result } from '../../shared/ipc'
import type { TokenGuardLaunchWarning, TokenGuardMigration, TokenGuardSnapshot, TokenGuardTrigger } from '../../shared/tokenGuard'
import type { TokenGuardValues } from '../../shared/tokenGuard'
import { SAVED_VISIBLE_MS } from '../components/saveStatusView'

const MIGRATION_POLL_MS = 1500

/** One key's write: `saving` holds the value its row shows meanwhile; after a failure `values` still holds the stored value. */
export type KeySave = { state: 'saving'; pendingValue: unknown } | { state: 'saved' } | { state: 'error'; error: string }

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
  /** Per-key write state, kept here so it survives a row remounting; a row with no entry has nothing to report. */
  saves: Record<string, KeySave>
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
  const savedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const forgetSaved = (key: string): void => {
    clearTimeout(savedTimers.get(key))
    savedTimers.delete(key)
  }
  // A write that returns after a newer write for the same key started must not overwrite that write's Saving….
  const writeSeq = new Map<string, number>()
  // Rows that are not the key being written stay editable; only these keys carry a save entry.
  const startSave = (keys: string[], pendingFor: (key: string) => unknown): Map<string, number> => {
    const saves = { ...get().saves }
    const started = new Map<string, number>()
    for (const key of keys) {
      forgetSaved(key)
      const seq = (writeSeq.get(key) ?? 0) + 1
      writeSeq.set(key, seq)
      started.set(key, seq)
      saves[key] = { state: 'saving', pendingValue: pendingFor(key) }
    }
    set({ saves })
    return started
  }
  // `showSaved` is false for Reset all: its dialog reports the outcome, and N rows flashing "Saved" would be noise.
  const endSave = (started: Map<string, number>, ok: boolean, showSaved: boolean): void => {
    const saves = { ...get().saves }
    const error = get().error ?? 'unknown error'
    for (const [key, seq] of started) {
      if (writeSeq.get(key) !== seq) continue
      if (!ok) saves[key] = { state: 'error', error }
      else if (showSaved) {
        saves[key] = { state: 'saved' }
        savedTimers.set(
          key,
          setTimeout(() => {
            savedTimers.delete(key)
            if (get().saves[key]?.state !== 'saved') return
            const rest = { ...get().saves }
            delete rest[key]
            set({ saves: rest })
          }, SAVED_VISIBLE_MS)
        )
      } else delete saves[key]
    }
    set({ saves })
  }
  const write = async (keys: string[], pendingFor: (key: string) => unknown, call: () => Promise<Result<TokenGuardSnapshot>>, showSaved: boolean): Promise<boolean> => {
    const started = startSave(keys, pendingFor)
    let ok = false
    try {
      ok = apply(await call(), true)
    } catch (e) {
      // A rejected call must not leave the rows disabled as "Saving…".
      set({ error: e instanceof Error ? e.message : String(e), warnings: [] })
      endSave(started, false, showSaved)
      throw e
    }
    endSave(started, ok, showSaved)
    return ok
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
    saves: {},
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
    set: (key, value) => write([key], () => value, () => window.refract.tokenGuard.set(key, value, repositoryId), true),
    reset: async (key) => void (await write([key], (k) => get().defaults[k], () => window.refract.tokenGuard.reset(key, repositoryId), true)),
    resetAll: async () => {
      const { values, defaults } = get()
      const changed = Object.keys(defaults).filter((key) => JSON.stringify(values[key]) !== JSON.stringify(defaults[key]))
      await write(changed, (key) => defaults[key], () => window.refract.tokenGuard.resetAll(repositoryId), false)
    },
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
