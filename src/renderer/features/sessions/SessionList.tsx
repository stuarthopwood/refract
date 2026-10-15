import { FolderPlusIcon, GitPullRequestIcon } from 'lucide-react'
import refractHero from '@/assets/brand/refract-hero.svg'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import { usePullRequestsStore, useRepositoriesStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import { ArchivedGroup } from './ArchivedGroup'
import { RepositoryGroup } from './RepositoryGroup'
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-2">
          {repositories.map((repository) => (
            <RepositoryGroup
              key={repository.id}
              repository={repository}
              sessions={sessions.filter((session) => session.repositoryId === repository.id)}
            />
          ))}
          <ArchivedGroup
            sessions={sessions.filter((session) => session.archivedAt)}
            repositoriesById={new Map(repositories.map((repository) => [repository.id, repository]))}
          />
        </div>
      </ScrollArea>
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
