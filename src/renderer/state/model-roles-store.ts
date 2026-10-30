import { create } from 'zustand'
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model'

// Model-role assignments and per-kind catalogs from `omp config`/`omp models`, applied immediately (#455).
// Failures go to per-role `saveErrors`/`overrideNotes` so the section can render and announce them inline.
// A second `load()`/`loadCatalog(kind, true)` joins the in-flight promise, so a stale result can't win.
interface ModelRolesState {
  roles: Record<string, string>
  loaded: boolean
  loadError: string | null
  pendingRoles: ReadonlySet<ModelRoleId>
  saveErrors: Partial<Record<ModelRoleId, string>>
  overrideNotes: Partial<Record<ModelRoleId, string>>
  catalogs: Partial<Record<CatalogKind, ModelCatalogEntry[]>>
  catalogErrors: Partial<Record<CatalogKind, string>>
  /** `keepError` (retry): leave `loaded`/`loadError` untouched until the result arrives, so the failed-load Alert and Retry stay mounted. */
  load(opts?: { keepError?: boolean }): Promise<void>
  /** Resolves once the write settles and never throws; the section announces the returned outcome. */
  setRole(role: ModelRoleId, value: string | null): Promise<{ ok: true } | { ok: false; message: string }>
  loadCatalog(kind: CatalogKind, force?: boolean): Promise<void>
}

export const useModelRolesStore = create<ModelRolesState>((set, get) => {
  // In-flight requests as closure variables (a Promise isn't renderable state).
  let loadInFlight: Promise<void> | null = null
  const catalogInFlight = new Map<CatalogKind, Promise<void>>()

  async function loadNow(opts?: { keepError?: boolean }): Promise<void> {
    if (!opts?.keepError) {
      set({ loaded: false, loadError: null })
    }
    const result = await window.refract.modelRoles.list()
    if (result.ok) {
      // Keep `roles` if a `setRole` is in flight: that write is authoritative and this read may predate it.
      set((state) => (state.pendingRoles.size > 0 ? { loaded: true, loadError: null } : { roles: result.value, loaded: true, loadError: null }))
    } else {
      set({ loaded: true, loadError: result.error.message })
    }
  }

  async function loadCatalogNow(kind: CatalogKind): Promise<void> {
    // Don't clear a cached error up front on retry: unmounting the Retry button would drop focus mid-retry.
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
        // Merge only this call's role from current state: replacing the whole map could revert another role's newer value (#1114).
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
