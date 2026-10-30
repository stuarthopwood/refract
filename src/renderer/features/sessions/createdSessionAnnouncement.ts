import type { Session } from '../../../shared/model'
import { useRepositoriesStore, useSessionListStore, useSessionsStore } from '@/state'
import { searchSessions } from './sessionDisplay'

const HIDDEN_SUFFIX = ', hidden by the session filter'

/**
 * Reads the session-list's own live state, not a snapshot passed in, so it is correct however long
 * after the create call it ends up running (#559).
 */
export function createdSessionAnnouncement(session: Pick<Session, 'id' | 'name' | 'repositoryId'>): string {
  const query = useSessionListStore.getState().query.trim()
  if (!query) return `Created session ${session.name}`
  const { matchingByRepository } = searchSessions(
    useSessionsStore.getState().sessions,
    useRepositoriesStore.getState().repositories,
    query,
    useSessionListStore.getState().showHidden
  )
  const matches = matchingByRepository.get(session.repositoryId)?.some((candidate) => candidate.id === session.id) ?? false
  return matches ? `Created session ${session.name}` : `Created session ${session.name}${HIDDEN_SUFFIX}`
}

export function wasHiddenByFilter(text: string): boolean {
  return text.endsWith(HIDDEN_SUFFIX)
}
