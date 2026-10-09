import { create } from 'zustand'
import type { Repository, RepositoryRemote } from '../../shared/model'
import { notify } from './notify'

// Gate round 4 fix (Low, a11y-auditor + security-auditor): structural equality for
// `setRemotes`' own merge below -- lets it keep the SAME repository object (and, if nothing
// anywhere changed, the same `state`) when a freshly computed value says the same thing the
// current one already does, instead of creating a new object (and re-rendering every group
// header) on every throttled focus refresh regardless of whether anything actually changed.
function remoteEquals(current: RepositoryRemote | undefined, next: RepositoryRemote): boolean {
  if (!current) return false
  if (current.kind !== next.kind) return false
  if (current.kind === 'has' && next.kind === 'has') return current.host === next.host
  return true
}

interface RepositoriesState {
  repositories: Repository[]
  setRepositories(repositories: Repository[]): void
  /** Issue #528, gate round 3 fix (Medium): merges a `repositories.remotes()` response into the
   * CURRENT `repositories` array by id -- a repository id absent from `remotes` (gate round 4
   * fix: the shared pool now leaves a deadline-cut-off repository out of its response entirely,
   * rather than sending an explicit `unknown` placeholder for it) is left exactly as it was, and
   * an id present in `remotes` but no longer in `repositories` (removed in the meantime) is
   * silently ignored, since there is nothing left to merge it onto. `add()`/`rename()` each
   * already set their own freshly computed `remote` on success; a `remotes()` response CAN still
   * arrive concurrently with one of those for the same repository (gate round 4 fix, a11y-
   * auditor: the round-3 doc comment's "never runs between" claim was not actually guaranteed) --
   * harmless either way, since every apply here is id-keyed and idempotent, and `remoteEquals`
   * below means a merge that happens to say the same thing a fresher value already does creates
   * no new object and no extra render. */
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
    set((state) => {
      let changed = false
      const repositories = state.repositories.map((repository) => {
        if (!Object.prototype.hasOwnProperty.call(remotes, repository.id)) return repository
        const next = remotes[repository.id]!
        if (remoteEquals(repository.remote, next)) return repository
        changed = true
        return { ...repository, remote: next }
      })
      return changed ? { repositories } : state
    }),
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
