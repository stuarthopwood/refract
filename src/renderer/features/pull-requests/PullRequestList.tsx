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
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FunnelIcon } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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

// Mirrors `PanelTabBar.tsx`'s own selected-tab treatment (`bg-muted text-foreground` plus an
// `after:` underline bar as the real, non-colour shape cue) and its `hover:bg-muted/50` resting
// state -- same contrast problem, same established fix, applied to this view's own Filter tabs
// now that #499 redesigns them (the old `TabsTrigger` default, `data-[state=active]:bg-background`
// against the list's `bg-muted` container, measured ~1.3:1 per the issue's own gate-round note).
const PR_FILTER_TAB_TRIGGER_CLASS =
  'relative flex-none rounded-md px-2 py-1 text-muted-foreground shadow-none hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-muted data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-foreground forced-colors:data-[state=active]:border forced-colors:data-[state=active]:border-[Highlight]'

// A soft fade at the clipped edge (decision 2): `-webkit-` kept alongside the unprefixed property
// since this app's Chromium/WebView2 baseline for plain element masking is not otherwise pinned.
const TABS_FADE_MASK_CLASS =
  '[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]'

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
  const setStateFilter = usePullRequestsStore((s) => s.setState)
  const setQuery = usePullRequestsStore((s) => s.setQuery)
  const selectPullRequest = usePullRequestsStore((s) => s.selectPullRequest)
  const refresh = usePullRequestsStore((s) => s.refresh)
  const refreshActiveCount = usePullRequestsStore((s) => s.refreshActiveCount)
  const githubStatus = useAccountsStore((s) => s.githubStatus)

  // Issue #499 decision 3/4: purely a visibility toggle -- the search query and State control it
  // reveals keep applying to `refresh()` while this section is closed (no reset on toggle).
  const [filtersOpen, setFiltersOpen] = useState(false)

  const tabsWrapRef = useRef<HTMLDivElement>(null)

  // Issue #499 decision 2: the active tab scrolls into view on every tab/repository change,
  // scrolling only this row's own wrapper (`PanelTabBar.tsx`'s established pattern for the same
  // problem -- a bare `scrollIntoView` would scroll every ancestor, not just this strip).
  // `relative` on the wrap (`PanelTabBar.tsx`'s own wrap has it too) is load-bearing, not
  // decorative: without a positioned wrap, `tab.offsetLeft` is measured against whichever
  // ancestor further up the tree happens to be `offsetParent`, so the computed scroll target
  // overshoots the wrap's real scrollable range and the browser silently clamps the assignment
  // short (caught live 2026-10-17: Enter-activating the last tab left it still partly clipped).
  useLayoutEffect(() => {
    const wrap = tabsWrapRef.current
    const tab = wrap?.querySelector<HTMLElement>('[data-state="active"]')
    if (!wrap || !tab) return
    const tabLeft = tab.offsetLeft
    const tabRight = tab.offsetLeft + tab.offsetWidth
    if (tabLeft < wrap.scrollLeft) wrap.scrollLeft = tabLeft
    else if (tabRight > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = tabRight - wrap.clientWidth
  }, [state.tab, repositoryId])

  // Fetches on open and whenever the scoped repository changes (FR-001); never polled
  // automatically afterward (FR-028) -- only the explicit refresh button and tab switch re-fetch.
  useEffect(() => {
    void refresh(repositoryId)
  }, [repositoryId, refresh])

  const friendlyError = state.error ? (ERROR_MESSAGES[state.error.code] ?? state.error.message) : null
  const activeFilterCount = (state.query.trim() !== '' ? 1 : 0) + (state.state !== 'open' ? 1 : 0)
  const filtersLabel = activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2">
      <Tabs value={state.tab} onValueChange={(value) => setTab(repositoryId, value as FilterTab)} activationMode="manual">
        <div className="flex items-center gap-0.5">
          <div ref={tabsWrapRef} className={cn('relative min-w-0 flex-1 overflow-x-auto', TABS_FADE_MASK_CLASS)}>
            <TabsList className="h-8 w-max shrink-0 justify-start gap-0.5 rounded-none bg-transparent p-0">
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className={PR_FILTER_TAB_TRIGGER_CLASS}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              {/* Matches `RefreshButton.tsx`'s own fix: the tooltip text duplicates `aria-label`,
                  so `aria-describedby={undefined}` stops Radix doubling the announcement. */}
              <TooltipTrigger asChild aria-describedby={undefined}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={filtersLabel}
                  aria-expanded={filtersOpen}
                  aria-controls="pull-request-filters-panel"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className={cn('relative', COMPOSER_BUTTON_FOCUS_CLASS)}
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
      </Tabs>
      {filtersOpen && (
        <div id="pull-request-filters-panel" className="flex items-center gap-2">
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
          <Select value={state.state} onValueChange={(value) => setStateFilter(repositoryId, value as PullRequestStateFilter)}>
            <SelectTrigger size="sm" aria-label="State" className="h-8 w-28 shrink-0">
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
          <div role="alert" className="p-3 text-sm text-destructive">
            {friendlyError}
          </div>
        ) : state.items.length === 0 && !state.loading ? (
          <div className="p-3 text-sm text-muted-foreground">No pull requests match this tab.</div>
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
