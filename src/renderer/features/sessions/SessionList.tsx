import { useEffect, useId, useRef } from 'react'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, FolderPlusIcon, GitPullRequestIcon, SearchXIcon } from 'lucide-react'
import refractHero from '@/assets/brand/refract-hero.svg'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useDefaultRepositoryId } from '@/lib/defaultRepository'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import { SearchField } from '@/components/SearchField'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { useAccountsStore, usePullRequestsStore, useRepositoriesStore, useSessionListStore, useSessionsStore, useViewStore } from '@/state'
import { ArchivedGroup } from './ArchivedGroup'
import { RepositoryGroup } from './RepositoryGroup'
import { searchSessions, showingCountLabel } from './sessionDisplay'
import { createdSessionAnnouncement, wasHiddenByFilter } from './createdSessionAnnouncement'
import { SESSION_SEARCH_INPUT_ATTR } from './sessionSearchSelector'

// Gate round 1 fix (High, ui-visual-system-v3): decision 23's literal focus class string
// (`focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2
// focus-visible:outline-ring`) draws nothing on `Button` -- its base `outline-none`
// (`button.tsx:7`) sets `outline-style: none`, which the decision's own classes never reset.
// `COMPOSER_BUTTON_FOCUS_CLASS` already carries the fix (`outline-solid`) for exactly this
// trap, so both toolbar buttons share one definition instead of two pasted ~260-character
// strings. Not exported: #748's Show hidden button (its own future reuse) does not exist yet.
//
// Gate round 2 fixes (ui-accessibility-auditor Medium/Low):
// - Dims only the glyph (`[&_svg]:opacity-50`), never the whole button, so the focus ring (also
//   inside this className) keeps its full contrast the moment the pressed button becomes
//   `aria-disabled` -- decision 13 keeps focus right there, so this is the ring's weakest moment.
// - The composer's own `COMPOSER_DISABLED_HOVER_RESET_CLASS` doesn't work for this toolbar:
//   `aria-disabled:hover:text-current` resolves to the *inherited* colour (this nav's
//   `text-sidebar-foreground`, near-white), not this button's own resting `muted-foreground`, so
//   a disabled icon still brightened on hover; and `aria-disabled:hover:bg-transparent` tied on
//   specificity with the adjacent `dark:hover:bg-sidebar-border` and lost, because `.dark` is
//   always set regardless of the active theme (`globals.css:18`) -- screenshot 04 showed the
//   grey hover fill behind a disabled button. Both resets below are written toolbar-specific and
//   `dark`-prefixed to actually win.
const SESSION_LIST_TOOLBAR_BUTTON_CLASS = cn(
  'text-muted-foreground hover:bg-sidebar-border hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:[&_svg]:opacity-50 dark:hover:bg-sidebar-border dark:aria-disabled:hover:bg-transparent aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
  COMPOSER_BUTTON_FOCUS_CLASS
)

// The session list (docs/DESIGN.md "Layout"): a collapsible group per Repository, Sessions
// sorted by most recent activity, and one cross-repository Archived group at the bottom of the
// list (issue #527). Its header (the Refract icon and name, spec 001 T100, FR-057) starts at the
// very top of the window and is part of the app's merged top row: draggable to move the window,
// double-click to maximise or restore.
export function SessionList() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  const openPullRequests = useViewStore((state) => state.openPullRequests)
  const view = useViewStore((state) => state.view)
  const selectPullRequest = usePullRequestsStore((state) => state.selectPullRequest)
  // #735 decisions 15-19: the persisted collapse/expand state. `restored` gates the
  // toolbar and every group below -- nothing paints open and then immediately snaps shut once
  // the persisted state loads a moment after Repositories do (decision 19).
  const restored = useSessionListStore((state) => state.restored)
  // Issue #559 decisions 17, 27: the search query, read raw for the matching/filtering below.
  const query = useSessionListStore((state) => state.query)
  const setQuery = useSessionListStore((state) => state.setQuery)
  const trimmedQuery = query.trim().toLowerCase()
  const hasQuery = trimmedQuery !== ''
  const collapseAllReasonId = useId()
  const expandAllReasonId = useId()
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // Decision 11: Archived counts toward "all" only while #527's own "hidden entirely while
  // nothing anywhere is archived" rule shows it; while hidden, its saved flag is ignored. Stays
  // computed from the UNFILTERED archived list regardless of any active search, since a group a
  // search hides still counts toward "all" (#735 decision 11).
  const archivedSessions = sessions.filter((session) => session.archivedAt && repositoriesById.has(session.repositoryId))
  const archivedVisible = archivedSessions.length > 0
  // Issue #559 decisions 13-16: `searchSessions` (sessionDisplay.tsx, gate round 1 fix,
  // code-reviewer Medium) is the ONE place that computes what the query matches, shared with
  // the debounced announcement below so the two can never silently disagree (for example once
  // #748 Hidden Sessions exist and only one copy excludes them). A Project group renders only
  // once at least one of its own non-archived Sessions matches, showing only the matching rows
  // (decision 15); Archived is searched the same way, against each row's own Project name
  // (decision 14). The derived header state each group computes (the Waiting marker, the
  // visible-Session bar, Archived's own count) follows automatically from whichever `sessions`
  // is passed in (decision 16).
  const { matchingByRepository, matchingArchived, shownCount, totalCount } = searchSessions(sessions, repositories, query)
  const visibleRepositoryEntries = repositories
    .map((repository) => ({ repository, sessions: matchingByRepository.get(repository.id) ?? [] }))
    .filter((entry) => !hasQuery || entry.sessions.length > 0)
  const visibleArchivedSessions = matchingArchived
  const noMatches = hasQuery && shownCount === 0
  const groupCount = repositories.length + (archivedVisible ? 1 : 0)
  // Gate round 1 fix (code-reviewer Medium, D18): computed through the store's own
  // `isGroupOpen`/`isArchivedGroupOpen` selectors in ONE hook call -- never the raw
  // `collapsedRepositoryIds`/`archivedOpen`/`searchOverride` fields, so the override-or-saved
  // rule has exactly one definition (session-list-store.ts), not a second copy here. Returns a
  // primitive number, so this still re-renders only when the count itself actually changes.
  const collapsedCount = useSessionListStore(
    (state) =>
      repositories.filter((repository) => !state.isGroupOpen(repository.id)).length +
      (archivedVisible && !state.isArchivedGroupOpen() ? 1 : 0)
  )
  // Decision 12: no special branch for zero groups -- both are vacuously true then, so both
  // buttons read as a no-op rather than one of them doing something undefined.
  const allCollapsed = collapsedCount === groupCount
  const allExpanded = collapsedCount === 0
  function handleCollapseAll(): void {
    if (allCollapsed) return
    useSessionListStore.getState().collapseAll(repositories.map((repository) => repository.id), archivedVisible)
    // #735 decision 14: one polite announcement for Collapse/Expand all (per-group toggles and
    // the startup restore stay silent -- `useChatAreaAnnouncer` survives the view swapping to
    // Settings or Manage sessions, the same reasoning this file's own create/restore paths use).
    useChatAreaAnnouncer.getState().announce('All groups collapsed')
  }
  function handleExpandAll(): void {
    if (allExpanded) return
    useSessionListStore.getState().expandAll(repositories.map((repository) => repository.id), archivedVisible)
    useChatAreaAnnouncer.getState().announce('All groups expanded')
  }
  // Issue #559 decisions 2, 23: the search field's own input ref (Ctrl+N's own App.tsx fallback,
  // decision 26, focuses it when the search hides every Project) and its polite result-count
  // announcement, debounced while typing (`ManageSessionsScreen.tsx`'s own established pattern).
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchAnnouncement, announceSearch] = useClearedAnnouncement()
  // Gate round 1 fix (a11y-auditor Low): started from the CURRENT trimmed query, not `''` -- a
  // remount that keeps a non-empty query (a Settings/Manage-sessions round trip) used to always
  // re-announce the count, since `''` never equals a kept query on the very first post-mount
  // render; now only a REAL change to the query announces anything.
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
      // Re-read live state at fire time (mirrors `ManageSessionsScreen.tsx`'s own debounced
      // announcement) so a Session that finished mid-debounce is reflected, not a stale snapshot
      // from the moment the keystroke landed. Shares `searchSessions` with the render path
      // above, so the two can never report a different count for the same state.
      const live = searchSessions(useSessionsStore.getState().sessions, useRepositoriesStore.getState().repositories, trimmedQuery)
      announceSearch(live.shownCount === 0 ? 'No sessions match' : showingCountLabel(live.shownCount, live.totalCount))
    }, 500)
    return () => clearTimeout(timer)
  }, [trimmedQuery])
  function handleClearSearch(): void {
    setQuery('')
    searchInputRef.current?.focus()
  }
  // Issue #559 gate round 1 (ui-architect-v3 finding 9, spec Edge Cases amendment): a Session
  // created while a query is active can land outside the filter (its generated adjective-noun
  // name does not match), so #735 decision 20's own "open the group" step produces no visible
  // row at all. Announces instead of silently hiding the new Session -- decision 13 ("search
  // never reveals a row") stays intact; this only ever announces, never shows the row. Detected
  // generically from the Session list itself changing, so every creation path (the header "+",
  // the branch picker, a row's "New session from {branch}", Ctrl+N) is covered uniformly
  // without threading this through each one's own call site.
  const previousSessionIdsRef = useRef(new Set(sessions.map((session) => session.id)))
  useEffect(() => {
    const previousIds = previousSessionIdsRef.current
    const currentIds = new Set(sessions.map((session) => session.id))
    previousSessionIdsRef.current = currentIds
    if (!hasQuery) return
    for (const session of sessions) {
      if (session.archivedAt || previousIds.has(session.id)) continue
      // Gate round 5 (Main's finding 7): `createdSessionAnnouncement` already computes its own
      // match decision via `searchSessions` -- re-deriving it here with `matchesSessionSearch`
      // was a second, redundant copy of that same decision (and a different helper than the one
      // this function itself relies on), so this just asks the one shared function for its
      // verdict instead of recomputing it.
      const announcement = createdSessionAnnouncement(session)
      if (wasHiddenByFilter(announcement)) useChatAreaAnnouncer.getState().announce(announcement)
    }
  }, [sessions, hasQuery, trimmedQuery])
  // Issue #620, UX consult item 2 decision 9: the row menu's "New session from {branch}" item's
  // "Creating session from {branch}" / "Created session {name}" announcements now go through
  // the app-level `useChatAreaAnnouncer` (#621's shared announcer, now that it exists on
  // `origin/main`) instead of a local region here, so they survive the view swapping to
  // Settings or Manage sessions during the multi-second checkout (gate round 2, a11y High) --
  // no `onAnnounce` prop or local live region needed in this file any more.
  // specs/003-pull-request-management FR-001, T011: the left-nav entry has no row of its own to
  // scope a repository from, unlike a Session row -- defaults to the currently focused pane's
  // Session's repository (App.tsx's own `frontSessionId` derivation), falling back to the first
  // added repository. `PullRequestsView.tsx`'s own repository dropdown (T012) is where the
  // developer changes this afterward. Issue #569: pulled into a shared, reactive
  // `useDefaultRepositoryId()` (`@/lib/defaultRepository`) so the trailing active-count readout
  // below can react to a real repository change, not just whatever re-render this component sees.
  const defaultRepositoryId = useDefaultRepositoryId()
  // Issue #569 decisions 1, 3, 4: the sidebar count. `null` covers "never fetched", "zero", and
  // "unavailable" alike -- all three render as nothing (decision 4), and `activeCountLabel` below
  // is the one place that distinction actually matters.
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const activeCount = usePullRequestsStore((state) =>
    defaultRepositoryId ? state.activeCountFor(defaultRepositoryId).count : null
  )
  const activeCountLabel =
    githubStatus === 'ready' && activeCount !== null && activeCount > 0 ? (activeCount >= 30 ? '30+' : String(activeCount)) : null
  // Issue #569 decision 2(a)/(b): fetches once per default repository that has no cached count
  // yet (covers both app startup and a genuine default-repository change) -- never on a timer.
  // The window focus/visibility refresh, the active-account-change clear, and the pull request
  // list's own explicit Refresh button all live in `init-stores.ts` / `PullRequestList.tsx`, not
  // here, and all skip while signed out of GitHub (`githubStatus !== 'ready'`).
  useEffect(() => {
    if (!defaultRepositoryId) return
    if (githubStatus !== 'ready') return
    if (usePullRequestsStore.getState().activeCountByRepository[defaultRepositoryId]) return
    void usePullRequestsStore.getState().refreshActiveCount(defaultRepositoryId)
  }, [defaultRepositoryId, githubStatus])

  function handleOpenPullRequests(): void {
    if (!defaultRepositoryId) return
    selectPullRequest(defaultRepositoryId, null)
    openPullRequests(defaultRepositoryId)
  }

  return (
    <nav
      aria-label="Sessions"
      tabIndex={-1}
      className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {/* Part of the app's merged top row (spec 001 T100, FR-057): draggable to move the window.
          No double-click handler here: verified live (tasks.md T100) that double-clicking this
          `.drag-region` already maximises/restores the window entirely at the OS level (HTCAPTION)
          before the double-click ever reaches the page's own JS, so a renderer-driven toggle was
          dead code and has been removed. */}
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
        <img src={refractHero} alt="" aria-hidden className="size-5 shrink-0" />
        <span className="text-sm font-semibold">Refract</span>
      </div>
      {/* specs/003-pull-request-management FR-001, T011: above the repository groups, Stuart's
          placement answer (spec 003 Clarifications). `aria-current` gives the selected state a
          visible AND accessible signal while the view is open, never colour alone (FR-030). */}
      <Button
        variant="ghost"
        aria-current={view === 'pull-requests' ? 'page' : undefined}
        className={cn(
          'relative mx-2 mt-2 h-8 justify-start gap-2 px-2 text-sm font-medium hover:bg-sidebar-accent dark:hover:bg-sidebar-accent',
          view === 'pull-requests' && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
        aria-label={activeCountLabel ? `Pull requests, ${activeCountLabel} active` : 'Pull requests'}
        onClick={handleOpenPullRequests}
      >
        {/* #567 decision 18: "A selected nav entry gets the 2px bar plus the fill", the same
            selected cue a Session row and a Group header's own visible-Session bar use. */}
        {view === 'pull-requests' && (
          <span
            aria-hidden
            className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
          />
        )}
        <GitPullRequestIcon aria-hidden className="size-4" />
        <span className="min-w-0 truncate">Pull requests</span>
        {/* Issue #569 decisions 3-4: a plain trailing count, never a box or `(N)` brackets
            (`GroupHeader.tsx`'s own "Archived" count convention) -- rendered only when a
            positive count is known; folded into the button's own `aria-label` above rather than
            a second announced region. */}
        {activeCountLabel && (
          <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
            {activeCountLabel} active
          </span>
        )}
      </Button>
      {restored && (
        <>
          {/* #735 decision 26 reserved this slot: between Pull requests and the toolbar. The
              `role="search"` landmark lives here, at the call site, not inside `SearchField`
              itself, so a future shared toolbar can embed the field without nesting a second
              landmark (#559 decision 3). `mx-2` lines the field up with Pull requests' own
              column, not the toolbar's `px-3` (decision 4). */}
          <div role="search" aria-label="Sessions" data-session-search-region className="mx-2 mt-4 shrink-0">
            <SearchField
              inputRef={searchInputRef}
              value={query}
              onValueChange={setQuery}
              label="Filter sessions by name, branch or project"
              placeholder="Filter sessions…"
              tooltipSide="right"
              // Gate round 1 fix (code-reviewer Medium): a stable hook on the input itself,
              // not a descendant-structure lookup (`[data-session-search-region] input`) a
              // future #934 `ListToolbar` embedding could break -- `App.tsx`'s Ctrl+N fallback
              // (`features/sessions/quickCreateFallback.ts`) and the shared focus-redirect hook
              // (`useFocusSearchOnStrandedUnmount.ts`) both select it directly.
              inputProps={{ [SESSION_SEARCH_INPUT_ATTR]: '' }}
            />
            <div aria-live="polite" aria-atomic="true" className="sr-only">
              {searchAnnouncement}
            </div>
          </div>
          {/* #735 decisions 4-9: pinned, outside and above the ScrollArea -- reachable from a
              long, scrolled list. No border/fill/label/role="toolbar" (zero-box rule; arrow-key
              roving is ruled out by #567 decision 17). `mt-2` (was `mt-4`): #559 decision 3 gives
              the 16px gap from Pull requests to the search field above instead, so this row's
              own gap shrinks to the 8px step under the field. */}
          <div className="mt-2 flex shrink-0 items-center justify-end gap-1 px-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Collapse all groups"
                  aria-disabled={allCollapsed || undefined}
                  aria-describedby={allCollapsed ? collapseAllReasonId : undefined}
                  className={SESSION_LIST_TOOLBAR_BUTTON_CLASS}
                  onClick={handleCollapseAll}
                >
                  <ChevronsDownUpIcon aria-hidden />
                  {/* Gate-fix precedent (GroupHeader.tsx's own `describedByPath` span): the
                      aria-describedby target must stay mounted whether or not the tooltip is
                      currently open -- a Radix TooltipContent is not always in the DOM, so a
                      reason span living only inside it would leave `aria-describedby` pointing
                      at nothing to assistive tech most of the time. */}
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
                  className={SESSION_LIST_TOOLBAR_BUTTON_CLASS}
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
            <div className="flex flex-col gap-3 p-2">
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
                      variant="outline"
                      size="sm"
                      onClick={handleClearSearch}
                      // Gate round 2 fix (ui-architect-v3/a11y-auditor Medium): matches the
                      // field's own Input and clear (x) button -- `Button`'s base `outline-none`
                      // draws no focus change at all under forced colours, which strips its
                      // box-shadow ring.
                      className="forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-1"
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
      {/* #447: the only way to add another repository once the first-run screen is gone. A
          persistent footer so it is always reachable; the dialog keeps its own validation and
          returns focus here on close. #567 decision 20: one soft `border-divider` above the
          whole footer block (this div, plus `ProfileItem.tsx` rendered right after it in
          `App.tsx` -- `ProfileItem.tsx`'s own `border-t` is removed so the two surfaces don't
          draw a double line), replacing the previous `border-sidebar-border`. Order (Add
          project, profile item, then #560's future alert rows) already falls out of render
          order: this footer's own Add repository button, then `App.tsx`'s sibling
          `<ProfileItem />` right below it. */}
      <div className="shrink-0 border-t border-divider p-2">
        <AddRepositoryDialog
          trigger={
            <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent">
              <FolderPlusIcon aria-hidden className="size-4" />
              Add repository
            </Button>
          }
        />
      </div>
    </nav>
  )
}
