import { useId } from 'react'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, FolderPlusIcon, GitPullRequestIcon } from 'lucide-react'
import refractHero from '@/assets/brand/refract-hero.svg'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { usePullRequestsStore, useRepositoriesStore, useSessionListStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import { ArchivedGroup } from './ArchivedGroup'
import { RepositoryGroup } from './RepositoryGroup'

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
  const collapsedRepositoryIds = useSessionListStore((state) => state.collapsedRepositoryIds)
  const archivedOpen = useSessionListStore((state) => state.archivedOpen)
  const restored = useSessionListStore((state) => state.restored)
  const collapseAllReasonId = useId()
  const expandAllReasonId = useId()
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // Decision 11: Archived counts toward "all" only while #527's own "hidden entirely while
  // nothing anywhere is archived" rule shows it; while hidden, its saved flag is ignored.
  const archivedSessions = sessions.filter((session) => session.archivedAt && repositoriesById.has(session.repositoryId))
  const archivedVisible = archivedSessions.length > 0
  const groupCount = repositories.length + (archivedVisible ? 1 : 0)
  const collapsedCount =
    repositories.filter((repository) => collapsedRepositoryIds.has(repository.id)).length +
    (archivedVisible && !archivedOpen ? 1 : 0)
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
  // developer changes this afterward.
  function defaultRepositoryId(): string | undefined {
    const splitState = useSplitStore.getState()
    const focusedSessionId = splitState.paneSessionIds[splitState.focusedIndex] ?? splitState.paneSessionIds[0]
    const focusedSession = sessions.find((session) => session.id === focusedSessionId)
    return focusedSession?.repositoryId ?? repositories[0]?.id
  }

  function handleOpenPullRequests(): void {
    const repositoryId = defaultRepositoryId()
    if (!repositoryId) return
    selectPullRequest(repositoryId, null)
    openPullRequests(repositoryId)
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
          'mx-2 mt-2 h-8 justify-start gap-2 px-2 text-sm font-medium',
          view === 'pull-requests' && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
        aria-label="Pull requests"
        onClick={handleOpenPullRequests}
      >
        <GitPullRequestIcon aria-hidden className="size-4" />
        Pull requests
      </Button>
      {restored && (
        <>
          {/* #735 decisions 4-9: pinned, outside and above the ScrollArea -- reachable from a
              long, scrolled list. No border/fill/label/role="toolbar" (zero-box rule; arrow-key
              roving is ruled out by #567 decision 17). */}
          <div className="mt-4 flex shrink-0 items-center justify-end gap-1 px-3">
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
              {repositories.map((repository) => (
                <RepositoryGroup
                  key={repository.id}
                  repository={repository}
                  sessions={sessions.filter((session) => session.repositoryId === repository.id)}
                />
              ))}
              <ArchivedGroup sessions={archivedSessions} repositoriesById={repositoriesById} />
            </div>
          </ScrollArea>
        </>
      )}
      {/* #447: the only way to add another repository once the first-run screen is gone. A
          persistent footer so it is always reachable; the dialog keeps its own validation and
          returns focus here on close. */}
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <AddRepositoryDialog
          trigger={
            <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-sm font-medium">
              <FolderPlusIcon aria-hidden className="size-4" />
              Add repository
            </Button>
          }
        />
      </div>
    </nav>
  )
}
