import type { Session } from '../../../shared/model'
import { useRepositoriesStore, useSessionListStore, useSessionsStore } from '@/state'
import { searchSessions } from './sessionDisplay'

// Gate round 5 (Main's finding, items 2 and 7): the one literal suffix that marks an
// announcement as "the Session was created but doesn't currently match the active filter" --
// shared so every call site that needs to know (not just display) the hidden/not-hidden
// decision tests the SAME string `createdSessionAnnouncement` itself appends, rather than each
// re-deriving it with its own separate `matchesSessionSearch`/`searchSessions` call that could
// drift out of sync with this function's own matching logic.
const HIDDEN_SUFFIX = ', hidden by the session filter'

/** Issue #559 gate round 3 (finding 4): the ONE place "Created session X" becomes "Created
 *  session X, hidden by the session filter" when a search query is active and the new Session's
 *  own name, branch, and Project all fail to match it. Every create call site that announces its
 *  own success now goes through this -- the row menu's "New session from {branch}"
 *  (`useSessionRowActions.ts`), Ctrl+N's fallback (`App.tsx`), the passive list-change detector
 *  (`SessionList.tsx`), and the Manage sessions screen's own create flow (`ManageSessionRow.tsx`,
 *  gate round 4) -- so whichever one's own announcement actually reaches the shared
 *  `useChatAreaAnnouncer` region first can never clobber a more informative one from another
 *  with a plain, uninformative "Created session X" (gate round 2's own race: the list-change
 *  detector and a call site's own post-create announcement could both fire for the same
 *  Session, and the shared region only ever holds the LAST text written to it). Reads the
 *  session-list's own live state, not a snapshot passed in, so it is correct however long after
 *  the create call it ends up running. */
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

/** Gate round 5 (Main's finding, items 2 and 7): true when `text` (a string this module itself
 *  produced) indicates the Session is hidden by the active filter -- the one place a call site
 *  decides whether to announce at all (for example a create path that ALSO moves focus
 *  successfully, where the plain "Created session X" case needs no announcement since the user
 *  can already see the new pane, but the hidden case still must be spoken). */
export function wasHiddenByFilter(text: string): boolean {
  return text.endsWith(HIDDEN_SUFFIX)
}
