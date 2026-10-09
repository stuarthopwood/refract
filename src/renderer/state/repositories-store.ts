import { create } from 'zustand'
import type { Repository, RepositoryRemote } from '../../shared/model'
import { notify } from './notify'

interface RepositoriesState {
  repositories: Repository[]
  setRepositories(repositories: Repository[]): void
  /** Issue #528, gate round 3 fix (Medium): merges a `repositories.remotes()` response into the
   * CURRENT `repositories` array by id -- a repository id absent from `remotes` (not yet
   * resolved by the shared pool's own deadline) is left exactly as it was, and an id present in
   * `remotes` but no longer in `repositories` (removed in the meantime) is silently ignored,
   * since there is nothing left to merge it onto. `add()`/`rename()` each already set their own
   * freshly computed `remote` on success; this never runs between those two steps for the same
   * repository (`remotes()` is only ever called once at startup and once per window-focus
   * throttle window), so there is nothing for it to overwrite with a stale value in practice. */
  setRemotes(remotes: Record<string, RepositoryRemote>): void
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
  setRemotes: (remotes) =>
    set((state) => ({
      repositories: state.repositories.map((repository) =>
        Object.prototype.hasOwnProperty.call(remotes, repository.id)
          ? { ...repository, remote: remotes[repository.id]! }
          : repository
      )
    })),
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
