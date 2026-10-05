// Manage sessions (spec 008 FR-025, FR-027, SC-007, T026 to T028): a cross-repository view over
// every Session `sessions.list()` already returns -- no new IPC, renderer-only, reusing the
// exact same archive/restore/delete/stop-agent/rename/open-in-split/copy-path/reveal actions and
// DeleteDialog.tsx the left-nav session list already offers (ManageSessionRow.tsx,
// sessionActions.ts). Header mirrors SettingsScreen.tsx's own drag-region/Back-to-chat shell;
// the list is plain DOM (no virtualisation: 5 to 60 sessions is lightweight, and virtualising
// would break both in-page find and the row-unmount focus-fallback chain below).
import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, FolderKanbanIcon, SearchXIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { focusProfileItemName } from '@/lib/focus'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import { ManageSessionRow } from './ManageSessionRow'
import { ManageSessionsToolbar } from './ManageSessionsToolbar'
import { DEFAULT_FILTERS, filterAndSortSessions, sessionCountLabel, showingCountLabel } from './manageSessionsHelpers'
import type { SessionFilters } from './manageSessionsHelpers'

export function ManageSessionsScreen() {
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS)
  const [announcement, announce] = useClearedAnnouncement()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]))

  // High remediation pattern (a11y, same as SettingsScreen.tsx): the profile menu's "Manage
  // sessions" item unmounts the instant this screen shows (App.tsx swaps the whole main area on
  // `view`), and nothing here would otherwise claim focus -- it would silently drop to `<body>`.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const visible = filterAndSortSessions(sessions, repositories, filters)
  const isFiltered =
    filters.search.trim() !== '' || filters.repositoryId !== 'all' || filters.archiveFilter !== 'all'

  // Announces only when the FILTER CRITERIA itself changes (a real toolbar interaction), never
  // when the underlying session list changes while filters stay put (an archive/restore/delete
  // action already announces its own outcome through this same region -- re-announcing the
  // count a moment later would stomp on that message).
  useEffect(() => {
    if (!isFiltered) return
    const current = filterAndSortSessions(useSessionsStore.getState().sessions, repositories, filters)
    announce(showingCountLabel(current.length, useSessionsStore.getState().sessions.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, filters.repositoryId, filters.archiveFilter])

  function handleBackToChat(): void {
    useViewStore.getState().openChat()
    // Post-build review fix (D3): reached from the profile menu's "Manage sessions" item, not
    // SessionList.tsx's cog, so the control to return to is the profile item's own name button,
    // not the Settings cog `focusSettingsEntry` queries -- mirroring that same helper's own
    // "query after the remount commits" pattern (SettingsScreen.tsx's `handleBackToChat`).
    requestAnimationFrame(() => focusProfileItemName())
  }

  function handleClearFilters(): void {
    setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })
    searchInputRef.current?.focus()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="no-drag-region size-7"
              aria-label="Back to chat"
              onClick={handleBackToChat}
            >
              <ArrowLeftIcon aria-hidden className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back to chat</TooltipContent>
        </Tooltip>
        <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
          Manage sessions
        </h1>
        <Badge variant="secondary">{sessionCountLabel(sessions.length, repositories.length)}</Badge>
      </div>

      <ManageSessionsToolbar
        filters={filters}
        repositories={repositories}
        searchInputRef={searchInputRef}
        onFiltersChange={setFilters}
        shownCount={visible.length}
        totalCount={sessions.length}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {sessions.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanbanIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No sessions yet</EmptyTitle>
              <EmptyDescription>Create a session from a repository in the left nav.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={handleBackToChat}>
                Back to chat
              </Button>
            </EmptyContent>
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No matching sessions</EmptyTitle>
              <EmptyDescription>No session's name, branch, repository, or archive state matches the current filters.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="ghost" onClick={handleClearFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul role="list" aria-label="All sessions across repositories" className="flex flex-col gap-1">
            {visible.map((session) => (
              <ManageSessionRow
                key={session.id}
                session={session}
                repositoryName={repositoryNameById.get(session.repositoryId) ?? 'Unknown repository'}
                searchInputRef={searchInputRef}
                onAnnounce={announce}
              />
            ))}
          </ul>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
