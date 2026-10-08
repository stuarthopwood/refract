// Manage sessions (spec 008 FR-025, FR-027, SC-007, T026 to T028): a cross-repository view over
// every Session `sessions.list()` already returns -- no new IPC, renderer-only, reusing the
// exact same archive/restore/delete/stop-agent/rename/open-in-split/copy-path/reveal actions and
// DeleteDialog.tsx the left-nav session list already offers (ManageSessionRow.tsx,
// sessionActions.ts). Header mirrors SettingsScreen.tsx's own drag-region/Back-to-chat shell;
// the list is plain DOM (no virtualisation: 5 to 60 sessions is lightweight, and virtualising
// would break both in-page find and the row-unmount focus-fallback chain below).
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowLeftIcon, FolderKanbanIcon, SearchXIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { focusProfileItemName } from '@/lib/focus'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import { ManageSessionRow } from './ManageSessionRow'
import { ManageSessionsToolbar } from './ManageSessionsToolbar'
import { distinctRepositoryCount, filterAndSortSessions, sessionCountLabel, showingCountLabel } from './manageSessionsHelpers'
import { DEFAULT_FILTERS } from '@/state/view-store'

export function ManageSessionsScreen() {
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  // Post-build review fix (Phase7PostBuild, Low): lives in view-store, not local `useState`, so
  // these survive opening a Session and coming back -- this screen unmounts entirely the instant
  // a row opens one (App.tsx swaps the whole main area on `view`), which previously reset every
  // filter to its default on return.
  const filters = useViewStore((state) => state.manageSessionsFilters)
  const setFilters = useViewStore((state) => state.setManageSessionsFilters)
  const [announcement, announce] = useClearedAnnouncement()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]))

  // High remediation pattern (a11y, same as SettingsScreen.tsx): the profile menu's "Manage
  // sessions" item unmounts the instant this screen shows (App.tsx swaps the whole main area on
  // `view`), and nothing here would otherwise claim focus -- it would silently drop to `<body>`.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const freshlySorted = filterAndSortSessions(sessions, repositories, filters)
  // Post-build review fix (Phase7PostBuild, Medium, [INFERENCE]): a live re-sort (the Status or
  // Recently active sort re-ranking a row whose own status/activity just changed) must never
  // reposition the DOM node underneath a half-typed rename -- freezes the row ORDER (never which
  // sessions are included) for as long as a rename `<input>` inside this list holds focus, and
  // reconciles against the latest `freshlySorted` the moment it no longer does.
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

  // Post-build review fix (Phase7PostBuild, Medium, WCAG 2.4.3): a row moved out from under
  // keyboard focus by a live re-sort (one this screen does NOT freeze above -- only an in-flight
  // rename pins the order) can drop focus to `<body>`. Tracks the last element focused anywhere
  // inside this list and, in a layout effect keyed on the resulting row ORDER, refocuses it
  // whenever focus has landed on `<body>` by the time that order settles.
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    if (lastFocusedRef.current?.isConnected) lastFocusedRef.current.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((session) => session.id).join(',')])

  const didMountRef = useRef(false)
  const prevFiltersRef = useRef(filters)
  const announceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Announces the filtered-result count whenever the filter CRITERIA itself changes (a real
  // toolbar interaction), never when the underlying session list changes while filters stay put
  // (an archive/restore/delete action already announces its own outcome through this same
  // region). A skip-first-run guard keeps mounting with the default filters silent. Post-build
  // review fix (Phase7PostBuild, Low): previously only fired while `isFiltered`, so Clear
  // filters -- itself a real filter-criteria change -- announced nothing; now always announces,
  // including the unfiltered count. Post-build review fix (accessibility-auditor, Medium): a
  // change to `search` ALONE (typing) debounces by ~500ms so a screen reader hears one count per
  // pause in typing rather than one per keystroke; a repository/archive-filter change (a Select
  // or ToggleGroup pick, never typed character-by-character) still announces immediately.
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
    // Post-build review fix (D3): reached from the profile menu's "Manage sessions" item, not
    // ProfileItem.tsx's cog, so the control to return to is the profile item's own name button,
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
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-divider px-3">
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
        <Badge variant="secondary">{sessionCountLabel(sessions.length, distinctRepositoryCount(sessions))}</Badge>
      </div>

      <ManageSessionsToolbar
        filters={filters}
        repositories={repositories}
        searchInputRef={searchInputRef}
        onFiltersChange={setFilters}
        shownCount={visible.length}
        totalCount={sessions.length}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
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
              <Button variant="outline" onClick={handleClearFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul
            ref={listRef}
            role="list"
            aria-label="All sessions across repositories"
            className="flex flex-col gap-1"
            onFocusCapture={(event) => {
              lastFocusedRef.current = event.target as HTMLElement
            }}
          >
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
