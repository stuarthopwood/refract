// The pull request list column (specs/003-pull-request-management FR-002 to FR-006, FR-026,
// FR-029, T013; redesigned per issue #499, 2026-10-16 decision): one non-wrapping, horizontally
// scrollable row of ghost Filter tabs (All, Authored by me, Assigned to me, Involves me, Review
// requested) -- the active tab gets a subtle background plus the same underline shape cue
// `PanelTabBar.tsx`'s own selected tab uses (gate round 1's own comment on this issue flagged
// that a background shift alone is well under the WCAG 1.4.11 non-text 3:1 floor, so a colour-
// only cue is not enough here either). A ghost Filters button and the shared RefreshButton sit
// pinned at the row's right end and never scroll; Filters toggles a disclosure section (the
// search field plus the State control: Open, Closed incl. merged, All) that keeps applying while
// closed, with a small dot on the Filters button when either is non-default. A "last updated"
// label and the no-github-remote/gh-unavailable/rate-limited error states round out the column.
import { useEffect, useRef, useState } from 'react'
import { FunnelIcon, SearchXIcon } from 'lucide-react'
import { FilterTabs } from '@/components/FilterTabs'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { SearchField } from '@/components/SearchField'
import { useAccountsStore, usePullRequestsStore } from '@/state'
import type { FilterTab, PullRequestStateFilter } from '../../../shared/github'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'
import { PullRequestRow } from './PullRequestRow'
import { RefreshButton } from './RefreshButton'

const TABS: Array<{ value: FilterTab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'authored', label: 'Authored by me' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'involves', label: 'Involves me' },
  { value: 'review-requested', label: 'Review requested' }
]

const STATE_OPTIONS: Array<{ value: PullRequestStateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' }
]

// The Filter tabs strip itself (fade, scroll-into-view, wheel mapping) is the shared
// `components/FilterTabs.tsx`.

// FR-002, FR-026: actionable text, never an empty or broken list in place of these.
const ERROR_MESSAGES: Record<string, string> = {
  'no-github-remote': 'This project has no GitHub remote.',
  'gh-unavailable': 'GitHub is not available: sign in with the GitHub CLI (gh auth login), or check your connection.',
  'rate-limited': 'GitHub rate limit reached. Try again in a few minutes.'
}

interface PullRequestListProps {
  repositoryId: string
}

export function PullRequestList({ repositoryId }: PullRequestListProps) {
  const state = usePullRequestsStore((s) => s.stateFor(repositoryId))
  const setTab = usePullRequestsStore((s) => s.setTab)
  const setStateFilter = usePullRequestsStore((s) => s.setState)
  const setQuery = usePullRequestsStore((s) => s.setQuery)
  const clearFilters = usePullRequestsStore((s) => s.clearFilters)
  const selectPullRequest = usePullRequestsStore((s) => s.selectPullRequest)
  const refresh = usePullRequestsStore((s) => s.refresh)
  const refreshActiveCount = usePullRequestsStore((s) => s.refreshActiveCount)
  const githubStatus = useAccountsStore((s) => s.githubStatus)

  // Issue #499 decision 3/4: purely a visibility toggle -- the search query and State control it
  // reveals keep applying to `refresh()` while this section is closed (no reset on toggle).
  const [filtersOpen, setFiltersOpen] = useState(false)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const filtersButtonRef = useRef<HTMLButtonElement>(null)

  // Fetches on open and whenever the scoped repository changes (FR-001); never polled
  // automatically afterward (FR-028) -- only the explicit refresh button and tab switch re-fetch.
  useEffect(() => {
    void refresh(repositoryId)
  }, [repositoryId, refresh])

  const friendlyError = state.error ? (ERROR_MESSAGES[state.error.code] ?? state.error.message) : null
  // Gate-fix (H3, caught live 2026-10-18): `appliedQuery` (set by `refresh()` itself, from the
  // query it actually fetched with), never the raw, still-typed `state.query` -- a developer
  // mid-keystroke, before Enter, used to see "Filters, 1 active" and a dot for a filter that had
  // not narrowed anything yet.
  const activeFilterCount = (state.appliedQuery.trim() !== '' ? 1 : 0) + (state.state !== 'open' ? 1 : 0)
  const filtersLabel = activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2">
      <div className="flex items-center gap-1">
        <FilterTabs value={state.tab} onValueChange={(value) => setTab(repositoryId, value)} tabs={TABS} revealKey={repositoryId} />
        <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              {/* Matches `RefreshButton.tsx`'s own fix: the tooltip text duplicates `aria-label`,
                  so `aria-describedby={undefined}` stops Radix doubling the announcement. */}
              <TooltipTrigger asChild aria-describedby={undefined}>
                <Button
                  ref={filtersButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={filtersLabel}
                  aria-expanded={filtersOpen}
                  // Gate-fix (L2, caught live 2026-10-18): `aria-controls` used to point at
                  // `pull-request-filters-panel` unconditionally, including while the section was
                  // closed and that id did not exist in the DOM at all (the panel only mounts
                  // while open) -- a reference to a non-existent element is invalid ARIA.
                  aria-controls={filtersOpen ? 'pull-request-filters-panel' : undefined}
                  onClick={() => setFiltersOpen((open) => !open)}
                  // Gate-fix (L4, caught live 2026-10-18): `aria-expanded:bg-muted` keeps this
                  // button visually marked as open for as long as the section stays open, not
                  // only while it is hovered or focused.
                  className={cn('relative aria-expanded:bg-muted aria-expanded:text-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
                >
                  <FunnelIcon aria-hidden className="size-4" />
                  {/* Decision 4: a small dot, never relied on alone -- the accessible name above
                      already carries "N active" for anyone who can't see it. */}
                  {activeFilterCount > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{filtersLabel}</TooltipContent>
            </Tooltip>
            <RefreshButton
              loading={state.loading}
              onClick={() => {
                // Issue #569 decision 2(e): the view's own explicit Refresh is one of the active
                // count's non-polling refresh triggers too -- the developer is already
                // demonstrating interest in this repository's pull request state, so the
                // sidebar's `involves`/open count rides along for free rather than waiting for
                // the next focus event. Gated on `githubStatus === 'ready'`, matching every other
                // active-count trigger (`SessionList.tsx`'s mount effect, `init-stores.ts`'s focus
                // refresh) -- a query with nobody signed in would only ever resolve to `null`.
                void refresh(repositoryId)
                if (githubStatus === 'ready') void refreshActiveCount(repositoryId)
              }}
              label="Refresh pull requests"
            />
          </div>
      </div>
      {filtersOpen && (
        <div
          id="pull-request-filters-panel"
          className="flex items-center gap-2"
          // Gate-fix (M4, caught live 2026-10-18): the shared `SearchField` owns its own Esc-
          // clear keydown handling internally and does not expose a raw `onKeyDown` override (by
          // design: a caller never gets to fight its own Esc contract) -- Enter-to-refresh is
          // wired one level up instead, scoped to the input itself so a State-select Enter (which
          // commits the highlighted option, not a search) is never also treated as a refresh.
          // Gate-fix (L4, caught live round 2 2026-10-18): `!isComposing` -- an IME composition's
          // own Enter (confirming a candidate, e.g. Japanese/Chinese input) must never also
          // trigger a refresh; the composition's own Enter is not a real submit.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) void refresh(repositoryId)
          }}
        >
          <SearchField
            value={state.query}
            onValueChange={(value) => setQuery(repositoryId, value)}
            label="Filter pull requests by title or label"
            placeholder="Filter by title or label"
            className="h-8 flex-1"
            inputRef={searchInputRef}
          />
          <Select value={state.state} onValueChange={(value) => setStateFilter(repositoryId, value as PullRequestStateFilter)}>
            <SelectTrigger aria-label="State" className="w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {STATE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="text-xs text-muted-foreground" aria-live="polite">
        {state.fetchedAt ? `Last updated ${formatRelativeTime(state.fetchedAt)}` : state.loading ? 'Loading...' : ''}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {friendlyError ? (
          <div role="alert" className="p-4 text-sm text-destructive">
            {friendlyError}
          </div>
        ) : state.items.length === 0 && !state.loading ? (
          // Gate-fix (M5, caught live 2026-10-18): a filtered-to-nothing list used to show the
          // exact same "No pull requests match this tab." copy as a genuinely empty tab, with no
          // way back to the unfiltered list except manually clearing the search box and the State
          // select one at a time.
          activeFilterCount > 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No pull requests match these filters.</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    clearFilters(repositoryId)
                    // Gate-fix (M2, caught live round 2 2026-10-18, test-reviewer Medium): this
                    // button unmounts the instant real (unfiltered) rows repopulate, stranding
                    // focus on <body>. Gate-fix (round 3, Medium, 4 reviewers): with the Filters
                    // section CLOSED there is no search field to receive it either -- falls back
                    // to the Filters button itself in that case. One frame via
                    // `requestAnimationFrame` lets the unmount/re-render settle first.
                    requestAnimationFrame(() => (filtersOpen ? searchInputRef : filtersButtonRef).current?.focus())
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">No pull requests match this tab.</div>
          )
        ) : (
          <div className="flex flex-col divide-y divide-divider">
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
