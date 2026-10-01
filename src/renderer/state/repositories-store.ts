import { create } from 'zustand'
import type { Repository } from '../../shared/model'
import { notify } from './notify'

interface RepositoriesState {
  repositories: Repository[]
  setRepositories(repositories: Repository[]): void
  add(path: string): Promise<Repository | null>
  remove(id: string): Promise<void>
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
      return
    }
    set({ repositories: get().repositories.filter((repository) => repository.id !== id) })
  }
}))
