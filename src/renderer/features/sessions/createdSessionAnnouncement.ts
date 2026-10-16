import type { Session } from '../../../shared/model'
import { useRepositoriesStore, useSessionListStore, useSessionsStore } from '@/state'
import { searchSessions } from './sessionDisplay'

/** Issue #559 gate round 3 (finding 4): the ONE place "Created session X" becomes "Created
 *  session X, hidden by the session filter" when a search query is active and the new Session's
 *  own name, branch, and Project all fail to match it. Every create call site that announces its
 *  own success now goes through this -- the row menu's "New session from {branch}"
 *  (`useSessionRowActions.ts`), Ctrl+N's fallback (`App.tsx`), and the passive list-change
 *  detector (`SessionList.tsx`) -- so whichever one's own announcement actually reaches the
 *  shared `useChatAreaAnnouncer` region first can never clobber a more informative one from
 *  another with a plain, uninformative "Created session X" (gate round 2's own race: the list-
 *  change detector and a call site's own post-create announcement could both fire for the same
 *  Session, and the shared region only ever holds the LAST text written to it). Reads the
 *  session-list's own live state, not a snapshot passed in, so it is correct however long after
 *  the create call it ends up running. */
export function createdSessionAnnouncement(session: Pick<Session, 'id' | 'name' | 'repositoryId'>): string {
  const query = useSessionListStore.getState().query.trim()
  if (!query) return `Created session ${session.name}`
  const { matchingByRepository } = searchSessions(useSessionsStore.getState().sessions, useRepositoriesStore.getState().repositories, query)
  const matches = matchingByRepository.get(session.repositoryId)?.some((candidate) => candidate.id === session.id) ?? false
  return matches ? `Created session ${session.name}` : `Created session ${session.name}, hidden by the session filter`
}
