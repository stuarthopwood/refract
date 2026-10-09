// The top-level Pull requests view (specs/003-pull-request-management FR-001, T012): a
// repository dropdown over a two-column layout -- the filterable list (PullRequestList.tsx) and
// the selected pull request's detail (PullRequestDetail.tsx) -- scoped to the repository chosen
// here, written back to the shared `view-store.ts` so the choice survives switching away and
// back (research.md decision 7).
import { useEffect, useRef } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePullRequestsStore, useRepositoriesStore, useViewStore } from '@/state'
import { PullRequestList } from './PullRequestList'
import { PullRequestDetail } from './PullRequestDetail'

export function PullRequestsView() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const viewRepositoryId = useViewStore((s) => s.repositoryId)
  const openPullRequests = useViewStore((s) => s.openPullRequests)
  const repositoryId = viewRepositoryId ?? repositories[0]?.id ?? null
  const selectedNumber = usePullRequestsStore((s) => s.stateFor(repositoryId ?? '').selectedNumber)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // High remediation (a11y, round 3): round 2's tasks.md T028 claimed this was already fixed --
  // it was never written at all (confirmed: zero commits touched this file for it). Matches
  // `SettingsScreen.tsx`'s exact established pattern: a real `<h2>`, `tabIndex={-1}` so it
  // accepts programmatic focus without joining the Tab order, focused once on mount so entering
  // this view from the left-nav lands keyboard/screen-reader users somewhere meaningful instead
  // of leaving focus on the nav button that was just activated.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Issue #500: this row used to have neither `drag-region` nor `no-drag-region` --
          `App.tsx`'s permanent full-width drag strip covers these pixels by default, so the
          repository Select (with no override) was inside a drag region and never received its
          click. Matches `SettingsScreen.tsx`/`SessionList.tsx`'s drag/no-drag pattern, with a
          corner spacer as in `ChatHeader.tsx`/`App.tsx`'s own strip -- this view touches the
          window-controls corner whenever the Subagents panel is collapsed (the same as a single,
          non-split `ChatPane`); when that panel is open it holds the corner instead, and this
          spacer is simply unused space, the same as `ChatPane`'s own always-on spacer. */}
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 ref={headingRef} tabIndex={-1} className="shrink-0 text-sm font-semibold outline-none">
          Pull requests
        </h2>
        {repositoryId && (
          <Select value={repositoryId} onValueChange={(value) => openPullRequests(value)}>
            {/* Quality-gate remediation (code-reviewer, Medium): the chat panel can shrink to
             * 360px (`App.tsx`'s `minSize={360}`); without `min-w-0`/`shrink` this `w-56` trigger
             * held its full width and pushed the trailing corner spacer past the window's right
             * edge, where it was clipped -- the Select's own right end then sat back under the
             * window buttons, the exact dead-click conflict #500 removed. `min-w-0`/`shrink` let
             * it shrink and truncate instead (the trigger's inner `SelectValue` already
             * `line-clamp-1`s, per `select.tsx`). */}
            <SelectTrigger
              size="sm"
              aria-label="Repository"
              title={repositories.find((repo) => repo.id === repositoryId)?.name}
              className="no-drag-region w-56 min-w-0 shrink"
            >
              <SelectValue placeholder="Select a repository" />
            </SelectTrigger>
            {/* Quality-gate remediation (accessibility-auditor, Medium): the default
             * `position="item-aligned"` lays the selected item over the trigger, so any item
             * above it (every item before the current selection) renders upward into this row's
             * top 40px -- the same drag strip `no-drag-region` exists to clear. `popper` opens the
             * list below the trigger instead; `no-drag-region` is a belt-and-braces override since
             * the portalled content otherwise sets no `-webkit-app-region` of its own. */}
            <SelectContent position="popper" className="no-drag-region">
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div
          aria-hidden
          className="no-drag-region ml-auto shrink-0"
          style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }}
        />
      </div>
      {!repositoryId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Add a repository to browse its pull requests.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 overflow-hidden border-r border-divider">
            <PullRequestList repositoryId={repositoryId} />
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            {selectedNumber !== null ? (
              <PullRequestDetail repositoryId={repositoryId} number={selectedNumber} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                Select a pull request to view its details.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
