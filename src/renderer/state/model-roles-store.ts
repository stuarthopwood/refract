import { toast } from 'sonner'
import { create } from 'zustand'
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model'
import { notify } from './notify'

// Issue #455: model-role assignments and the per-role-kind catalog listing, both read through
// `omp config`/`omp models` (never `settings.json` -- these live in OMP's own global config).
// Immediate-apply, like `settings-store.ts`'s other toggles: there is no Save/Cancel step.
interface ModelRolesState {
  roles: Record<string, string>
  loaded: boolean
  loadError: string | null
  pendingRoles: ReadonlySet<ModelRoleId>
  catalogs: Partial<Record<CatalogKind, ModelCatalogEntry[]>>
  catalogErrors: Partial<Record<CatalogKind, string>>
  load(): Promise<void>
  setRole(role: ModelRoleId, value: string | null): Promise<void>
  loadCatalog(kind: CatalogKind): Promise<void>
}

export const useModelRolesStore = create<ModelRolesState>((set, get) => ({
  roles: {},
  loaded: false,
  loadError: null,
  pendingRoles: new Set(),
  catalogs: {},
  catalogErrors: {},

  load: async () => {
    const result = await window.refract.modelRoles.list()
    if (result.ok) {
      set({ roles: result.value, loaded: true, loadError: null })
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
      set({ roles: result.value.roles, pendingRoles: next })
      if (result.value.overriddenBy) {
        // Not an error (the write itself succeeded) -- `toast.info` matches this app's existing
        // "succeeded, but here's a caveat" pattern (MessageInput.tsx's queued-message notice).
        toast.info(`Saved, but ${result.value.overriddenBy} still controls the effective model for this role.`)
      }
    } else {
      set({ pendingRoles: next })
      notify(result.error)
    }
  },

  loadCatalog: async (kind) => {
    if (get().catalogs[kind] || get().catalogErrors[kind]) return
    const result = await window.refract.modelRoles.listCatalog(kind)
    if (result.ok) {
      set({ catalogs: { ...get().catalogs, [kind]: result.value } })
    } else {
      set({ catalogErrors: { ...get().catalogErrors, [kind]: result.error.message } })
    }
  }
}))
