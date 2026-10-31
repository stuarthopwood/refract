import { useEffect, useLayoutEffect, useRef } from 'react'
import { FolderKanbanIcon, SearchXIcon } from 'lucide-react'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { focusProfileItemName } from '@/lib/focus'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { ManageSessionRow } from './ManageSessionRow'
import { ManageSessionsToolbar } from './ManageSessionsToolbar'
import { distinctRepositoryCount, filterAndSortSessions, sessionCountLabel } from './manageSessionsHelpers'
import { showingCountLabel } from '@/features/sessions/sessionDisplay'
import { DEFAULT_FILTERS } from '@/state/view-store'
import { HolidayEmptyStateLine } from '@/features/holidays/HolidayEmptyStateLine'

export function ManageSessionsScreen() {
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const filters = useViewStore((state) => state.manageSessionsFilters)
  const setFilters = useViewStore((state) => state.setManageSessionsFilters)
  const [announcement, announce] = useClearedAnnouncement()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]))
  const repositoryById: Map<string, Repository> = new Map(repositories.map((repository) => [repository.id, repository] as const))

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const freshlySorted = filterAndSortSessions(sessions, repositories, filters)
  const activeElement = typeof document !== 'undefined' ? document.activeElement : null
  const renameInputFocused = activeElement instanceof HTMLInputElement && !!listRef.current?.contains(activeElement)
  const frozenOrderRef = useRef<string[] | null>(null)
  let visible: SessionSummary[]
  if (renameInputFocused && frozenOrderRef.current) {
    const byId = new Map(freshlySorted.map((session) => [session.id, session]))
    const frozenIds = new Set(frozenOrderRef.current)
    visible = [
      ...frozenOrderRef.current.map((id) => byId.get(id)).filter((session): session is SessionSummary => !!session),
      ...freshlySorted.filter((session) => !frozenIds.has(session.id))
    ]
  } else {
    visible = freshlySorted
  }
  frozenOrderRef.current = visible.map((session) => session.id)

  const lastFocusedRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    if (lastFocusedRef.current?.isConnected) lastFocusedRef.current.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((session) => session.id).join(',')])

  const didMountRef = useRef(false)
  const prevFiltersRef = useRef(filters)
  const announceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const previous = prevFiltersRef.current
    prevFiltersRef.current = filters
    if (announceDebounceRef.current) {
      clearTimeout(announceDebounceRef.current)
      announceDebounceRef.current = null
    }
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }

    function announceCurrentCount(): void {
      const state = useSessionsStore.getState()
      const current = filterAndSortSessions(state.sessions, repositories, filters)
      announce(showingCountLabel(current.length, state.sessions.length))
    }

    const onlySearchChanged =
      filters.search !== previous.search &&
      filters.repositoryId === previous.repositoryId &&
      filters.archiveFilter === previous.archiveFilter

    if (onlySearchChanged) {
      announceDebounceRef.current = setTimeout(() => {
        announceDebounceRef.current = null
        announceCurrentCount()
      }, 500)
    } else {
      announceCurrentCount()
    }

    return () => {
      if (announceDebounceRef.current) {
        clearTimeout(announceDebounceRef.current)
        announceDebounceRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, filters.repositoryId, filters.archiveFilter])

  function handleBackToChat(): void {
    useViewStore.getState().openChat()
    requestAnimationFrame(() => focusProfileItemName())
  }

  function handleClearFilters(): void {
    setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })
    searchInputRef.current?.focus()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Manage sessions"
        headingRef={headingRef}
        backLabel="Back to chat"
        onBack={handleBackToChat}
        contained
        count={sessionCountLabel(sessions.length, distinctRepositoryCount(sessions))}
      />

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        {sessions.length > 0 && (
          <ManageSessionsToolbar
            filters={filters}
            repositories={repositories}
            searchInputRef={searchInputRef}
            onFiltersChange={setFilters}
            shownCount={visible.length}
            totalCount={sessions.length}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderKanbanIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>Go back to chat and start a session from a project.</EmptyDescription>
                <HolidayEmptyStateLine className="mt-1 block text-xs text-muted-foreground" />
              </EmptyHeader>
            </Empty>
          ) : visible.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No matching sessions</EmptyTitle>
                <EmptyDescription>No session's name or branch matches your search, or none fit the selected tab and project.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ul
              ref={listRef}
              role="list"
              aria-label="All sessions across projects"
              className="flex flex-col gap-1"
              onFocusCapture={(event) => {
                lastFocusedRef.current = event.target as HTMLElement
              }}
            >
              {visible.map((session) => (
                <ManageSessionRow
                  key={session.id}
                  session={session}
                  repository={repositoryById.get(session.repositoryId)}
                  repositoryName={repositoryNameById.get(session.repositoryId) ?? 'Unknown project'}
                  searchInputRef={searchInputRef}
                  onAnnounce={announce}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
