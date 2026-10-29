import { useAccountsStore, useRepositoriesStore } from '@/state'

// #505: the cached photo of the active GitHub account on the repository's host. A primitive
// string, so every row shares one value and a transcript re-renders only when the photo changes.
export function useRepositoryAvatarUrl(repositoryId: string | null): string | undefined {
  const host = useRepositoriesStore((state) => {
    const remote = repositoryId ? state.repositories.find((repository) => repository.id === repositoryId)?.remote : undefined
    return remote?.kind === 'has' ? remote.host.toLowerCase() : undefined
  })
  return useAccountsStore((state) => {
    if (!host) return undefined
    return state.github.find((account) => account.active && account.host.toLowerCase() === host)?.avatarDataUrl ?? undefined
  })
}
