import { useEffect, useId, useRef } from 'react'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, SearchXIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { SearchField } from '@/components/SearchField'
import { AddProjectMenu } from '@/features/sessions/AddProjectMenu'
import { ViewsNavGroup } from './ViewsNavGroup'
import { TOOLBAR_BUTTON_CLASS } from '@/components/toolbarButtonClass'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useRepositoriesStore, useSessionListStore, useSessionsStore } from '@/state'
import { ArchivedGroup } from './ArchivedGroup'
import { RepositoryGroup } from './RepositoryGroup'
import { ShowHiddenToggle } from './ShowHiddenToggle'
import type { SessionSummary } from '../../../shared/ipc'
import { searchSessions, showingCountLabel } from './sessionDisplay'
import { createdSessionAnnouncement, wasHiddenByFilter } from './createdSessionAnnouncement'
import { SESSION_SEARCH_INPUT_ATTR } from './sessionSearchSelector'

/** The session list: a collapsible group per Repository, plus one cross-repository Archived group; its header is part of the merged top row. */
export function SessionList() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  // `restored` gates the toolbar and groups so nothing paints open then snaps shut once persisted state loads (#735).
  const restored = useSessionListStore((state) => state.restored)
  const query = useSessionListStore((state) => state.query)
  const setQuery = useSessionListStore((state) => state.setQuery)
  const trimmedQuery = query.trim().toLowerCase()
  const hasQuery = trimmedQuery !== ''
  // Issue #748: Show hidden; a hidden Session is listed only while it is on (or a search matches it).
  const showHidden = useSessionListStore((state) => state.showHidden)
  const collapseAllReasonId = useId()
  const expandAllReasonId = useId()
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // Archived counts toward "all" only while shown, and is computed from the unfiltered list since a search-hidden group still counts (#735).
  const archivedSessions = sessions.filter(
    (session) => session.archivedAt && repositoriesById.has(session.repositoryId) && (!session.hiddenAt || showHidden)
  )
  const archivedVisible = archivedSessions.length > 0
  // `searchSessions` is the one place that computes query matches, shared with the debounced announcement so they cannot disagree.
  // A group renders only when one of its non-archived Sessions matches (#559).
  const { matchingByRepository, matchingArchived, shownCount, totalCount } = searchSessions(sessions, repositories, query, showHidden)
  // Issue #748: a Project whose every non-archived Session is hidden disappears while Show hidden is off.
  const hasListedSessions = (repositoryId: string, listed: SessionSummary[]): boolean =>
    showHidden || hasQuery || listed.length > 0 || !sessions.some((s) => s.repositoryId === repositoryId && s.hiddenAt && !s.archivedAt)
  const visibleRepositoryEntries = repositories
    .map((repository) => ({ repository, sessions: matchingByRepository.get(repository.id) ?? [] }))
    .filter((entry) => !hasQuery || entry.sessions.length > 0)
    .filter((entry) => hasListedSessions(entry.repository.id, entry.sessions))
  const visibleArchivedSessions = matchingArchived
  const noMatches = hasQuery && shownCount === 0
  const groupCount = repositories.length + (archivedVisible ? 1 : 0)
  // Use the store's `isGroupOpen`/`isArchivedGroupOpen` selectors so the open rule has one definition; returns a number to limit re-renders.
  const collapsedCount = useSessionListStore(
    (state) =>
      repositories.filter((repository) => !state.isGroupOpen(repository.id)).length +
      (archivedVisible && !state.isArchivedGroupOpen() ? 1 : 0)
  )
  // With zero groups both are vacuously true, so both buttons read as a no-op.
  const allCollapsed = collapsedCount === groupCount
  const allExpanded = collapsedCount === 0
  function handleCollapseAll(): void {
    if (allCollapsed) return
    useSessionListStore.getState().collapseAll(repositories.map((repository) => repository.id), archivedVisible)
    // One polite announcement for Collapse/Expand all; `useChatAreaAnnouncer` survives the view swapping to Settings.
    useChatAreaAnnouncer.getState().announce('All groups collapsed')
  }
  function handleExpandAll(): void {
    if (allExpanded) return
    useSessionListStore.getState().expandAll(repositories.map((repository) => repository.id), archivedVisible)
    useChatAreaAnnouncer.getState().announce('All groups expanded')
  }
  // The search input ref (Ctrl+N's fallback focuses it) and a debounced polite result-count announcement.
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchAnnouncement, announceSearch] = useClearedAnnouncement()
  // Start from the current query, not `''`, so a remount that keeps a query does not re-announce.
  const previousTrimmedQueryRef = useRef(trimmedQuery)
  useEffect(() => {
    const previous = previousTrimmedQueryRef.current
    previousTrimmedQueryRef.current = trimmedQuery
    if (trimmedQuery === previous) return
    if (trimmedQuery === '') {
      announceSearch('Filter cleared')
      return
    }
    const timer = setTimeout(() => {
      // Re-read live state at fire time so a Session that finished mid-debounce is reflected.
      const live = searchSessions(
        useSessionsStore.getState().sessions,
        useRepositoriesStore.getState().repositories,
        trimmedQuery,
        useSessionListStore.getState().showHidden
      )
      announceSearch(live.shownCount === 0 ? 'No sessions match' : showingCountLabel(live.shownCount, live.totalCount))
    }, 500)
    return () => clearTimeout(timer)
  }, [trimmedQuery])
  function handleClearSearch(): void {
    setQuery('')
    searchInputRef.current?.focus()
  }
  // A Session created while a query is active may land outside the filter; announce it rather than reveal the row (#559).
  // Detected from the Session list changing, so every creation path is covered.
  const previousSessionIdsRef = useRef(new Set(sessions.map((session) => session.id)))
  useEffect(() => {
    const previousIds = previousSessionIdsRef.current
    const currentIds = new Set(sessions.map((session) => session.id))
    previousSessionIdsRef.current = currentIds
    if (!hasQuery) return
    for (const session of sessions) {
      if (session.archivedAt || previousIds.has(session.id)) continue
      // `createdSessionAnnouncement` already decides the match via `searchSessions`.
      const announcement = createdSessionAnnouncement(session)
      if (wasHiddenByFilter(announcement)) useChatAreaAnnouncer.getState().announce(announcement)
    }
  }, [sessions, hasQuery, trimmedQuery])
  return (
    <nav
      aria-label="Sessions"
      tabIndex={-1}
      className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      <ViewsNavGroup />
      {restored && (
        <>
          {/* `role="search"` lives here, not in `SearchField`, so a shared toolbar can embed the field without nesting a landmark (#559). */}
          <div role="search" aria-label="Sessions" data-session-search-region className="mx-2 mt-4 shrink-0">
            <SearchField
              inputRef={searchInputRef}
              value={query}
              onValueChange={setQuery}
              label="Filter sessions by name, branch or project"
              placeholder="Filter sessions…"
              tooltipSide="right"
              // A stable hook on the input, not a descendant lookup a `ListToolbar` embedding could break.
              inputProps={{ [SESSION_SEARCH_INPUT_ATTR]: '' }}
            />
            <div aria-live="polite" aria-atomic="true" className="sr-only">
              {searchAnnouncement}
            </div>
          </div>
          {/* Pinned above the ScrollArea; no border, fill or `role="toolbar"` (#567 rules out arrow-key roving). */}
          <div className="mt-2 flex shrink-0 items-center justify-end gap-1 px-4">
            <ShowHiddenToggle />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Collapse all groups"
                  data-collapse-all-groups=""
                  aria-disabled={allCollapsed || undefined}
                  aria-describedby={allCollapsed ? collapseAllReasonId : undefined}
                  className={TOOLBAR_BUTTON_CLASS}
                  onClick={handleCollapseAll}
                >
                  <ChevronsDownUpIcon aria-hidden />
                  {/* The `aria-describedby` target stays mounted even when the tooltip is closed. */}
                  {allCollapsed && (
                    <span id={collapseAllReasonId} className="sr-only">
                      All groups are collapsed
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="flex flex-col gap-1">
                  <span>Collapse all groups</span>
                  {allCollapsed && <span aria-hidden>All groups are collapsed</span>}
                </div>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Expand all groups"
                  aria-disabled={allExpanded || undefined}
                  aria-describedby={allExpanded ? expandAllReasonId : undefined}
                  className={TOOLBAR_BUTTON_CLASS}
                  onClick={handleExpandAll}
                >
                  <ChevronsUpDownIcon aria-hidden />
                  {allExpanded && (
                    <span id={expandAllReasonId} className="sr-only">
                      All groups are expanded
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="flex flex-col gap-1">
                  <span>Expand all groups</span>
                  {allExpanded && <span aria-hidden>All groups are expanded</span>}
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-2">
              {noMatches ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="default">
                      <SearchXIcon aria-hidden className="size-4 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>No sessions match</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleClearSearch}
                      // Same offset as the field's Input and clear button; `Button` already sets the forced-colours outline.
                      className="forced-colors:focus-visible:outline-offset-1"
                    >
                      Clear filter
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <>
                  {visibleRepositoryEntries.map(({ repository, sessions }) => (
                    <RepositoryGroup key={repository.id} repository={repository} sessions={sessions} />
                  ))}
                  <ArchivedGroup sessions={visibleArchivedSessions} repositoriesById={repositoriesById} />
                </>
              )}
            </div>
          </ScrollArea>
        </>
      )}
      {/* The one persistent footer for adding a repository; its divider is inset like the Views separator (#1385). */}
      <div className="shrink-0">
        <div aria-hidden className="mx-2 border-t border-divider" />
        <div className="p-2">
          <AddProjectMenu variant="footer" />
        </div>
      </div>
    </nav>
  )
}
