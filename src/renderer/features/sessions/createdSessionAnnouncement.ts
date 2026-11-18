import { isProjectSession, type Session } from '../../../shared/model'
import type { SessionSummary } from '../../../shared/ipc'
import { useRepositoriesStore, useSessionListStore, useSessionsStore } from '@/state'
import { searchSessions } from './sessionDisplay'

const HIDDEN_SUFFIX = ', hidden by the session filter'

const createdText = (name: string): string => `Created session ${name}`

/**
 * Reads the session-list's own live state, not a snapshot passed in, so it is correct however long
 * after the create call it ends up running (#559).
 */
export function createdSessionAnnouncement(session: Session): string {
  const query = useSessionListStore.getState().query.trim()
  if (!query) return createdText(session.name)
  const { matchingByRepository } = searchSessions(
    useSessionsStore.getState().sessions,
    useRepositoriesStore.getState().repositories,
    query,
    useSessionListStore.getState().showHidden
  )
  const matches =
    !isProjectSession(session) || (matchingByRepository.get(session.repositoryId)?.some((candidate) => candidate.id === session.id) ?? false)
  return matches ? createdText(session.name) : `${createdText(session.name)}${HIDDEN_SUFFIX}`
}

export function wasHiddenByFilter(text: string): boolean {
  return text.endsWith(HIDDEN_SUFFIX)
}

/** FR-012: a child's creation names its parent and says "(collapsed)" when the parent's children are hidden; it never expands the parent or moves focus. */
export function createdChildAnnouncement(child: Pick<SessionSummary, 'name'>, parent: Pick<SessionSummary, 'name'>, collapsed: boolean): string {
  return `${child.name} created under ${parent.name}${collapsed ? ' (collapsed)' : ''}`
}

/**
 * One announcement per Session new to `sessions` since `previousIds`. A child with a known parent gets the
 * child wording (plus the filter suffix when a query hides it); any other new Session is announced only
 * when the query hides it (#559). An empty `previousIds` is the first load and announces no child.
 */
export function newSessionAnnouncements(
  previousIds: ReadonlySet<string>,
  sessions: readonly SessionSummary[],
  isCollapsed: (parentId: string) => boolean,
  isFilteredOut: (session: SessionSummary) => boolean
): string[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const messages: string[] = []
  for (const session of sessions) {
    if (session.archivedAt || previousIds.has(session.id)) continue
    const filteredOut = isFilteredOut(session)
    const parent = previousIds.size > 0 && session.parentSessionId ? byId.get(session.parentSessionId) : undefined
    if (parent) messages.push(`${createdChildAnnouncement(session, parent, isCollapsed(parent.id))}${filteredOut ? HIDDEN_SUFFIX : ''}`)
    else if (filteredOut) messages.push(`${createdText(session.name)}${HIDDEN_SUFFIX}`)
  }
  return messages
}
