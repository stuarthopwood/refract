import { create } from 'zustand'
import type { ProjectColor, Repository, RepositoryRemote } from '../../shared/model'
import { notify } from './notify'
import { useSessionListStore } from './session-list-store'

function remoteEquals(current: RepositoryRemote | undefined, next: RepositoryRemote): boolean {
  if (!current) return false
  if (current.kind !== next.kind) return false
  if (current.kind === 'has' && next.kind === 'has') return current.host === next.host
  return true
}

interface RepositoriesState {
  repositories: Repository[]
  setRepositories(repositories: Repository[]): void
  setRemotes(remotes: Record<string, RepositoryRemote>): void
  add(path: string): Promise<Repository | null>
  addLocal(repository: Repository): void
  remove(id: string): Promise<boolean>
  rename(id: string, name: string): Promise<string | null>
  setColor(id: string, color: ProjectColor | null): Promise<string | null>
}

function refreshRemotesAfterAdd(): void {
  void window.refract.repositories
    .remotes()
    .then((result) => {
      if (result.ok) useRepositoriesStore.getState().setRemotes(result.value)
    })
    .catch(() => {})
}

/** Store of known repositories. */
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
    refreshRemotesAfterAdd()
    return result.value
  },
  addLocal: (repository) => {
    if (get().repositories.some((existing) => existing.id === repository.id)) return
    set({ repositories: [...get().repositories, repository] })
    refreshRemotesAfterAdd()
  },
  remove: async (id) => {
    const result = await window.refract.repositories.remove(id)
    if (!result.ok) {
      notify(result.error)
      return false
    }
    const repositories = get().repositories.filter((repository) => repository.id !== id)
    set({ repositories })
    useSessionListStore.getState().pruneRepositories(new Set(repositories.map((repository) => repository.id)))
    return true
  },
  rename: async (id, name) => {
    const result = await window.refract.repositories.rename(id, name)
    if (!result.ok) return result.error.message
    set({ repositories: get().repositories.map((repository) => (repository.id === id ? result.value : repository)) })
    return null
  },
  setColor: async (id, color) => {
    const result = await window.refract.repositories.setColor(id, color)
    if (!result.ok) return result.error.message
    set({
      repositories: get().repositories.map((repository) =>
        repository.id === id ? { ...result.value, remote: repository.remote } : repository
      )
    })
    return null
  }
}))
