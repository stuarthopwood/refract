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
interface ModelRolesState {
  roles: Record<string, string>
  loaded: boolean
  loadError: string | null
  pendingRoles: ReadonlySet<ModelRoleId>
  saveErrors: Partial<Record<ModelRoleId, string>>
  overrideNotes: Partial<Record<ModelRoleId, string>>
  catalogs: Partial<Record<CatalogKind, ModelCatalogEntry[]>>
  catalogErrors: Partial<Record<CatalogKind, string>>
  load(): Promise<void>
  /** Resolves once the write settles; throws nothing -- check the returned outcome (and/or
   * `saveErrors[role]`) to decide what to announce (the section component owns announcing, this
   * store only tracks state). */
  setRole(role: ModelRoleId, value: string | null): Promise<{ ok: true } | { ok: false; message: string }>
  loadCatalog(kind: CatalogKind, force?: boolean): Promise<void>
}

export const useModelRolesStore = create<ModelRolesState>((set, get) => ({
  roles: {},
  loaded: false,
  loadError: null,
  pendingRoles: new Set(),
  saveErrors: {},
  overrideNotes: {},
  catalogs: {},
  catalogErrors: {},

  load: async () => {
    // Quality-gate remediation (code-reviewer MEDIUM): reset to the loading state up front,
    // so a Retry after a failure actually shows 'Loading model roles…' again instead of leaving
    // the stale error on screen for the whole request.
    set({ loaded: false, loadError: null })
    const result = await window.refract.modelRoles.list()
    if (result.ok) {
      // Quality-gate remediation (test-reviewer LOW): never clobber `roles` with this read if a
      // `setRole` write is still in flight for some role -- that write's own result is the
      // authoritative one, and applying a `load()` that started before it resolves can revert
      // whatever the user is in the middle of changing.
      set((state) => (state.pendingRoles.size > 0 ? { loaded: true } : { roles: result.value, loaded: true, loadError: null }))
    } else {
      set({ loaded: true, loadError: result.error.message })
    }
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
      set({ roles: result.value.roles, pendingRoles: next, saveErrors: errors, overrideNotes: notes })
      return { ok: true }
    }
    set({ pendingRoles: next, saveErrors: { ...get().saveErrors, [role]: result.error.message } })
    return { ok: false, message: result.error.message }
  },

  loadCatalog: async (kind, force = false) => {
    if (!force && (get().catalogs[kind] || get().catalogErrors[kind])) return
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
}))
