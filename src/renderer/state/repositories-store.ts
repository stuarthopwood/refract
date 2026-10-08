import { create } from 'zustand'
import type { Repository } from '../../shared/model'
import { notify } from './notify'

interface RepositoriesState {
  repositories: Repository[]
  setRepositories(repositories: Repository[]): void
  add(path: string): Promise<Repository | null>
  remove(id: string): Promise<boolean>
  /** Quality-gate fix (a11y, Medium, 2026-10-08): returns the error message (not a bare
   * `false`) so the rename input can show it inline (`aria-describedby`) instead of only a
   * toast -- the caller keeps the field open and the typed draft intact on failure. `null`
   * means the rename succeeded and `repositories` was already updated with the server's
   * resolved value. */
  rename(id: string, name: string): Promise<string | null>
}

// Repositories the developer has added to Refract (contracts/ipc.md "Repositories").
export const useRepositoriesStore = create<RepositoriesState>((set, get) => ({
  repositories: [],
  setRepositories: (repositories) => set({ repositories }),
  add: async (path) => {
    const result = await window.refract.repositories.add(path)
    if (!result.ok) {
      notify(result.error)
      return null
    }
    set({ repositories: [...get().repositories, result.value] })
    return result.value
  },
  remove: async (id) => {
    const result = await window.refract.repositories.remove(id)
    if (!result.ok) {
      notify(result.error)
      return false
    }
    set({ repositories: get().repositories.filter((repository) => repository.id !== id) })
    return true
  },
  // Issue #480: the IPC handler returns the full updated Repository (its name may have reset to
  // the folder basename if the committed value was empty after trimming), so the store applies
  // that exact value rather than re-sending whatever the caller passed in.
  rename: async (id, name) => {
    const result = await window.refract.repositories.rename(id, name)
    if (!result.ok) return result.error.message
    set({ repositories: get().repositories.map((repository) => (repository.id === id ? result.value : repository)) })
    return null
  }
}))
