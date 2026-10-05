// The pull request list column (specs/003-pull-request-management FR-002 to FR-006, FR-026,
// FR-029, T013): five filter tabs defaulting to Open, a narrowing filter, a refresh button, a
// "last updated" label, and the no-github-remote/gh-unavailable/rate-limited error states as an
// actionable message in place of the list.
import { useEffect } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { usePullRequestsStore } from '@/state'
import type { FilterTab } from '../../../shared/github'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'
import { PullRequestRow } from './PullRequestRow'

const TABS: Array<{ value: FilterTab; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'authored', label: 'Authored by me' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'involves', label: 'Involves me' },
  { value: 'review-requested', label: 'Review requested' }
]

// FR-002, FR-026: actionable text, never an empty or broken list in place of these.
const ERROR_MESSAGES: Record<string, string> = {
  'no-github-remote': 'This repository has no GitHub remote.',
  'gh-unavailable': 'GitHub is not available: sign in with the GitHub CLI (gh auth login), or check your connection.',
  'rate-limited': 'GitHub rate limit reached. Try again in a few minutes.'
}

interface PullRequestListProps {
  repositoryId: string
}

export function PullRequestList({ repositoryId }: PullRequestListProps) {
  const state = usePullRequestsStore((s) => s.stateFor(repositoryId))
  const setTab = usePullRequestsStore((s) => s.setTab)
  const setQuery = usePullRequestsStore((s) => s.setQuery)
  const selectPullRequest = usePullRequestsStore((s) => s.selectPullRequest)
  const refresh = usePullRequestsStore((s) => s.refresh)

  // Fetches on open and whenever the scoped repository changes (FR-001); never polled
  // automatically afterward (FR-028) -- only the explicit refresh button and tab switch re-fetch.
  useEffect(() => {
    void refresh(repositoryId)
  }, [repositoryId, refresh])

  const friendlyError = state.error ? (ERROR_MESSAGES[state.error.code] ?? state.error.message) : null

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2">
      {/* High remediation: a live screenshot confirmed the 5 filter tab labels genuinely clip at
          this column's default ~320px width ("Review requested" was fully cut off) -- `h-auto
          flex-wrap` lets them wrap to a second row instead of overflowing past the column and
          being hidden by its `overflow-hidden`. `activationMode="manual"` (also High remediation,
          code-reviewer): Radix's default automatic activation fires a real `gh` call on every
          arrow-key FOCUS move between tabs, not just a committed choice -- manual activation
          requires Enter/Space, matching every other list-style control in this view. */}
      <Tabs value={state.tab} onValueChange={(value) => setTab(repositoryId, value as FilterTab)} activationMode="manual">
        <TabsList className="h-auto flex-wrap justify-start">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-2">
        <Input
          value={state.query}
          onChange={(e) => setQuery(repositoryId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(repositoryId)
          }}
          placeholder="Filter by title or label"
          aria-label="Filter pull requests by title or label"
          className="h-8 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => void refresh(repositoryId)}
          aria-label="Refresh pull requests"
        >
          <RefreshCwIcon aria-hidden className={cn('size-3.5', state.loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      <div className="text-xs text-muted-foreground" aria-live="polite">
        {state.fetchedAt ? `Last updated ${formatRelativeTime(state.fetchedAt)}` : state.loading ? 'Loading...' : ''}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {friendlyError ? (
          <div role="alert" className="p-3 text-sm text-destructive">
            {friendlyError}
          </div>
        ) : state.items.length === 0 && !state.loading ? (
          <div className="p-3 text-sm text-muted-foreground">No pull requests match this tab.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {state.items.map((pr) => (
              <PullRequestRow
                key={pr.number}
                pullRequest={pr}
                selected={state.selectedNumber === pr.number}
                onSelect={() => selectPullRequest(repositoryId, pr.number)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
