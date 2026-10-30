import { useRepositoriesStore } from '../state/repositories-store'
import { useSessionsStore } from '../state/sessions-store'
import { useSplitStore } from '../state/split-store'

function resolve(
  repositories: { id: string }[],
  sessions: { id: string; repositoryId: string }[],
  focusedSessionId: string | undefined
): string | undefined {
  const focusedSession = sessions.find((session) => session.id === focusedSessionId)
  return focusedSession?.repositoryId ?? repositories[0]?.id
}

export function useDefaultRepositoryId(): string | undefined {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  const focusedSessionId = useSplitStore((state) => state.paneSessionIds[state.focusedIndex] ?? state.paneSessionIds[0])
  return resolve(repositories, sessions, focusedSessionId)
}

export function getDefaultRepositoryId(): string | undefined {
  const splitState = useSplitStore.getState()
  const focusedSessionId = splitState.paneSessionIds[splitState.focusedIndex] ?? splitState.paneSessionIds[0]
  return resolve(useRepositoriesStore.getState().repositories, useSessionsStore.getState().sessions, focusedSessionId)
}
