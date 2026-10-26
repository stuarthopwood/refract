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
import { FunnelIcon, SearchXIcon } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

// Mirrors `PanelTabBar.tsx`'s own selected-tab treatment (`bg-muted text-foreground` plus an
// `after:` underline bar as the real, non-colour shape cue) and its `hover:bg-muted/50` resting
// state -- same contrast problem, same established fix, applied to this view's own Filter tabs
// now that #499 redesigns them (the old `TabsTrigger` default, `data-[state=active]:bg-background`
// against the list's `bg-muted` container, measured ~1.3:1 per the issue's own gate-round note).
// Gate-fix (M2, caught live 2026-10-18): `focus-visible:outline-offset-[-2px] focus-visible:ring-
// inset` -- this strip's wrap is `overflow-x-auto`, which clips a tab's own focus ring/outline at
// the wrap's edge for the first or last visible tab; drawing both inward (`DiffView.tsx`'s own
// established pattern for the identical overflow-clipping problem) keeps them visible.
const PR_FILTER_TAB_TRIGGER_CLASS =
  'relative flex-none rounded-md px-2 py-1 text-muted-foreground shadow-none hover:bg-muted/50 hover:text-foreground focus-visible:outline-offset-[-2px] focus-visible:ring-inset data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-foreground forced-colors:data-[state=active]:border forced-colors:data-[state=active]:border-[Highlight]'

// Gate-fix (M1, caught live 2026-10-18): a STATIC mask used to fade both edges unconditionally,
// even the start edge while already fully scrolled to the start (nothing clipped there to fade).
// `TABS_FADE_PX` is shared between the CSS (`globals.css`'s own `.pr-tabs-fade[data-fade-*]`
// rules, which must use the identical literal pixel value) and the scroll-into-view margin below,
// so the active tab never lands flush behind its own fade. The wrap's own `data-fade-left`/
// `data-fade-right` attributes (toggled by the effect below, from real `scrollLeft`/`scrollWidth`/
// `clientWidth` measurements, on every scroll and `ResizeObserver` tick) drive which, if either,
// of those CSS rules actually applies -- never a fade on an edge that has nothing clipped.
const TABS_FADE_PX = 24

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
  const clearFilters = usePullRequestsStore((s) => s.clearFilters)
  const selectPullRequest = usePullRequestsStore((s) => s.selectPullRequest)
  const refresh = usePullRequestsStore((s) => s.refresh)
  const refreshActiveCount = usePullRequestsStore((s) => s.refreshActiveCount)
  const githubStatus = useAccountsStore((s) => s.githubStatus)

  // Issue #499 decision 3/4: purely a visibility toggle -- the search query and State control it
  // reveals keep applying to `refresh()` while this section is closed (no reset on toggle).
  const [filtersOpen, setFiltersOpen] = useState(false)

  const tabsWrapRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filtersButtonRef = useRef<HTMLButtonElement>(null)

  // Issue #499 decision 2: the active tab scrolls into view on every tab/repository change,
  // scrolling only this row's own wrapper (`PanelTabBar.tsx`'s established pattern for the same
  // problem -- a bare `scrollIntoView` would scroll every ancestor, not just this strip).
  // `relative` on the wrap (`PanelTabBar.tsx`'s own wrap has it too) is load-bearing, not
  // decorative: without a positioned wrap, `tab.offsetLeft` is measured against whichever
  // ancestor further up the tree happens to be `offsetParent`, so the computed scroll target
  // overshoots the wrap's real scrollable range and the browser silently clamps the assignment
  // short (caught live 2026-10-17: Enter-activating the last tab left it still partly clipped).
  // Gate-fix (M1, caught live 2026-10-18): the scroll-into-view margin now leaves `TABS_FADE_PX`
  // of slack on whichever side the active tab approaches, so it never lands flush behind its own
  // fade; `updateFade` (scroll + `ResizeObserver`, not just the tab/repository change this effect
  // already re-runs on) keeps `data-fade-left`/`data-fade-right` honest the rest of the time too
  // -- a manual trackpad/wheel scroll, or the column being resized, with no tab switch at all.
  useLayoutEffect(() => {
    const wrap = tabsWrapRef.current
    if (!wrap) return
    const updateFade = () => {
      wrap.toggleAttribute('data-fade-left', wrap.scrollLeft > 0)
      wrap.toggleAttribute('data-fade-right', wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1)
    }
    // Gate-fix (round 3, UI Medium): factored out of this effect's own one-time run so the
    // ResizeObserver below can re-reveal the active tab too -- resizing the list column used to
    // only refresh the fade flags, leaving the active tab stranded under the fade if the column
    // narrowed enough to clip it with no tab/repository change to re-trigger this effect.
    const revealActiveTab = () => {
      const tab = wrap.querySelector<HTMLElement>('[data-state="active"]')
      if (!tab) return
      const tabLeft = tab.offsetLeft
      const tabRight = tab.offsetLeft + tab.offsetWidth
      if (tabLeft < wrap.scrollLeft + TABS_FADE_PX) wrap.scrollLeft = Math.max(0, tabLeft - TABS_FADE_PX)
      else if (tabRight > wrap.scrollLeft + wrap.clientWidth - TABS_FADE_PX) wrap.scrollLeft = tabRight - wrap.clientWidth + TABS_FADE_PX
    }
    revealActiveTab()
    updateFade()
    wrap.addEventListener('scroll', updateFade, { passive: true })
    const observer = new ResizeObserver(() => {
      revealActiveTab()
      updateFade()
    })
    observer.observe(wrap)
    // Gate-fix (M4, caught live round 2 2026-10-18, test-reviewer Medium): a mouse with no
    // horizontal wheel/tilt-scroll could not reach the tabs past the fade at all -- maps a
    // vertical wheel delta onto `scrollLeft` while the row can still scroll further in that
    // direction, `passive: false` only because this conditionally calls `preventDefault` (never
    // unconditionally, so an already-at-the-end wheel still scrolls the page normally).
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      // Gate-fix (round 3, Low): the same 1px tolerance as the fade check above (subpixel
      // scroll rounding could otherwise leave this perpetually "true" right at the true end,
      // trapping every further wheel tick instead of letting it scroll the page).
      const canScrollMore = e.deltaY > 0 ? wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1 : wrap.scrollLeft > 0
      if (!canScrollMore) return
      e.preventDefault()
      wrap.scrollLeft += e.deltaY
    }
    wrap.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      wrap.removeEventListener('scroll', updateFade)
      wrap.removeEventListener('wheel', handleWheel)
      observer.disconnect()
    }
  }, [state.tab, repositoryId])

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
      <Tabs value={state.tab} onValueChange={(value) => setTab(repositoryId, value as FilterTab)} activationMode="manual">
        <div className="flex items-center gap-0.5">
          {/* Gate-fix (M1, caught live 2026-10-18): the mask is now driven entirely by
              `data-fade-left`/`data-fade-right` (`globals.css`'s own `.pr-tabs-fade` rules), never
              a static gradient on both edges regardless of whether either is actually clipped.
              `[scrollbar-width:none]`/`[&::-webkit-scrollbar]:hidden` hide the native scrollbar
              this row never needed visible -- its own fade already signals more content, and the
              bare scrollbar track pushed the tab row's own vertical centring off by its height.
              Gate-fix (M5, caught live round 2 2026-10-18): `scroll-px-6` (24px, matching
              `TABS_FADE_PX`) sets `scroll-padding-inline` so the BROWSER's own native scroll-
              into-view-on-focus (roving tabindex arrow-key moves, Radix Tabs) keeps a newly-
              focused tab clear of the fade too, not just the active-tab effect above. */}
          <div
            ref={tabsWrapRef}
            className="relative min-w-0 flex-1 scroll-px-6 overflow-x-auto pr-tabs-fade [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
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
      </Tabs>
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
          <div role="alert" className="p-3 text-sm text-destructive">
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
            <div className="p-3 text-sm text-muted-foreground">No pull requests match this tab.</div>
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
