import { create } from 'zustand'
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model'

// Issue #455: model-role assignments and the per-role-kind catalog listing, both read through
// `omp config`/`omp models` (never `settings.json` -- these live in OMP's own global config).
// Immediate-apply, like `settings-store.ts`'s other toggles: there is no Save/Cancel step.
//
// Quality-gate remediation (accessibility-auditor HIGH): a failed `setRole` used to go only to
// a `toast.error` (auto-dismissing, untied to the field). `saveErrors` now holds a per-role
// message instead, so the section can render it inline (`aria-describedby`/`aria-invalid`) and
// announce it itself -- this store no longer calls `notify()` at all. `overrideNotes` is the
// same idea for the 'overriddenBy' caveat (accessibility-auditor LOW): inline per role, not an
// auto-dismissing `toast.info`.
//
// `load()` and `loadCatalog(kind, true)` both return the SAME in-flight promise to a second
// caller made while the first has not yet settled, rather than starting a redundant second IPC
// round trip (quality-gate remediation, gate cycle 4 MEDIUM: the section's own `retryingLoad`/
// `retryingKinds` React-state guards read from the render closure, so a test or a sufficiently
// fast double-activation had no store-level backstop proving only one call actually happened).
// This also closes a cycle-3 LOW the code reviewer flagged on its own: an older call can no
// longer race a newer one and have its stale result win, since there is only ever one in-flight
// promise per load-kind at a time -- a second caller always joins the one already running.
interface ModelRolesState {
  roles: Record<string, string>
  loaded: boolean
  loadError: string | null
  pendingRoles: ReadonlySet<ModelRoleId>
  saveErrors: Partial<Record<ModelRoleId, string>>
  overrideNotes: Partial<Record<ModelRoleId, string>>
  catalogs: Partial<Record<CatalogKind, ModelCatalogEntry[]>>
  catalogErrors: Partial<Record<CatalogKind, string>>
  /** `opts.keepError`: used by a retry after a failure -- leaves `loaded`/`loadError` exactly as
   * they are until the result arrives (mirrors `loadCatalog`'s own forced-retry behaviour),
   * instead of flipping back to the loading state up front. That is what keeps the failed-load
   * Alert and its Retry button mounted throughout a retry (quality-gate remediation, gate cycle 3
   * HIGH: the previous unconditional reset unmounted the Alert the instant a retry started, so
   * the "Retrying…" label and `aria-disabled` state could never actually be seen, and the
   * section's own "retry succeeded" focus effect fired at the START of every retry instead of
   * only on a real success). A call made while an earlier one is still in flight joins that one
   * instead of starting a second request (module header). */
  load(opts?: { keepError?: boolean }): Promise<void>
  /** Resolves once the write settles; throws nothing -- check the returned outcome (and/or
   * `saveErrors[role]`) to decide what to announce (the section component owns announcing, this
   * store only tracks state). */
  setRole(role: ModelRoleId, value: string | null): Promise<{ ok: true } | { ok: false; message: string }>
  loadCatalog(kind: CatalogKind, force?: boolean): Promise<void>
}

export const useModelRolesStore = create<ModelRolesState>((set, get) => {
  // Module-header note: these two track in-flight requests per load-kind so a second concurrent
  // call joins the first instead of starting its own. Plain closure variables (not store state):
  // a `Promise` is not meaningfully renderable, and nothing outside this file ever needs to read
  // "is a load in flight" directly -- the section's own `loaded`/`retryingLoad`/`retryingKinds`
  // already expose that for rendering.
  let loadInFlight: Promise<void> | null = null
  const catalogInFlight = new Map<CatalogKind, Promise<void>>()

  async function loadNow(opts?: { keepError?: boolean }): Promise<void> {
    if (!opts?.keepError) {
      // The very first call (component mount): nothing cached is worth keeping, so this is the
      // loading-state reset `loadCatalog` has no equivalent of.
      set({ loaded: false, loadError: null })
    }
    const result = await window.refract.modelRoles.list()
    if (result.ok) {
      // Quality-gate remediation (test-reviewer LOW): never clobber `roles` with this read if a
      // `setRole` write is still in flight for some role -- that write's own result is the
      // authoritative one, and applying a `load()` that started before it resolves can revert
      // whatever the user is in the middle of changing. `loadError: null` here too (quality-gate
      // remediation, gate cycle 4 MEDIUM, code-reviewer: this branch used to omit it, so a
      // `keepError:true` retry that succeeded while a write was still pending left the OLD error
      // message and its Alert on screen even though the read just worked).
      set((state) => (state.pendingRoles.size > 0 ? { loaded: true, loadError: null } : { roles: result.value, loaded: true, loadError: null }))
    } else {
      set({ loaded: true, loadError: result.error.message })
    }
  }

  async function loadCatalogNow(kind: CatalogKind): Promise<void> {
    // Quality-gate remediation (accessibility-auditor MEDIUM): do NOT clear a cached error up
    // front on a forced retry -- the section keeps the existing error (and its Retry button)
    // mounted and marks it 'Retrying…' itself, so this call never causes an unmount that would
    // drop keyboard/screen-reader focus mid-retry. Only the final outcome below ever changes
    // catalogErrors/catalogs.
    const result = await window.refract.modelRoles.listCatalog(kind)
    if (result.ok) {
      const errors = { ...get().catalogErrors }
      delete errors[kind]
      set({ catalogs: { ...get().catalogs, [kind]: result.value }, catalogErrors: errors })
    } else {
      set({ catalogErrors: { ...get().catalogErrors, [kind]: result.error.message } })
    }
  }

  return {
    roles: {},
    loaded: false,
    loadError: null,
    pendingRoles: new Set(),
    saveErrors: {},
    overrideNotes: {},
    catalogs: {},
    catalogErrors: {},

    load: (opts) => {
      if (loadInFlight) return loadInFlight
      const promise = loadNow(opts).finally(() => {
        loadInFlight = null
      })
      loadInFlight = promise
      return promise
    },

    setRole: async (role, value) => {
      const pending = new Set(get().pendingRoles)
      pending.add(role)
      set({ pendingRoles: pending })
      const result = await window.refract.modelRoles.set(role, value)
      const next = new Set(get().pendingRoles)
      next.delete(role)
      if (result.ok) {
        const errors = { ...get().saveErrors }
        delete errors[role]
        const notes = { ...get().overrideNotes }
        if (result.value.overriddenBy) notes[role] = result.value.overriddenBy
        else delete notes[role]
        // Gate round 1 fix (#1114, Medium #6, pre-existing): replacing the WHOLE `roles` map
        // with THIS call's own reply can revert a DIFFERENT role's own newer value if that
        // role's own `setRole` call started later but its own reply (no live Session to sweep)
        // arrived first -- this call's own `result.value.roles` was read by the backend BEFORE
        // that happened. Merge only the ONE role this call actually changed, from the CURRENT
        // state (which may already hold that other role's newer value), never the whole map.
        const roles = { ...get().roles }
        const savedValue = result.value.roles[role]
        if (savedValue === undefined) delete roles[role]
        else roles[role] = savedValue
        set({ roles, pendingRoles: next, saveErrors: errors, overrideNotes: notes })
        return { ok: true }
      }
      set({ pendingRoles: next, saveErrors: { ...get().saveErrors, [role]: result.error.message } })
      return { ok: false, message: result.error.message }
    },

    loadCatalog: (kind, force = false) => {
      if (!force && (get().catalogs[kind] || get().catalogErrors[kind])) return Promise.resolve()
      const existing = catalogInFlight.get(kind)
      if (existing) return existing
      const promise = loadCatalogNow(kind).finally(() => {
        catalogInFlight.delete(kind)
      })
      catalogInFlight.set(kind, promise)
      return promise
    }
  }
})
