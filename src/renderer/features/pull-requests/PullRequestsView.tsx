// The top-level Pull requests view (specs/003-pull-request-management FR-001, T012): a
// repository dropdown over a two-column layout -- the filterable list (PullRequestList.tsx) and
// the selected pull request's detail (PullRequestDetail.tsx) -- scoped to the repository chosen
// here, written back to the shared `view-store.ts` so the choice survives switching away and
// back (research.md decision 7).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  PULL_REQUESTS_LIST_MIN_WIDTH_PX,
  usePullRequestsLayoutStore,
  usePullRequestsStore,
  useRepositoriesStore,
  useViewStore
} from '@/state'
import { PullRequestList } from './PullRequestList'
import { PullRequestDetail } from './PullRequestDetail'

export function PullRequestsView({ reservesWindowControls = true }: { reservesWindowControls?: boolean }) {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const viewRepositoryId = useViewStore((s) => s.repositoryId)
  const openPullRequests = useViewStore((s) => s.openPullRequests)
  const repositoryId = viewRepositoryId ?? repositories[0]?.id ?? null
  const selectedNumber = usePullRequestsStore((s) => s.stateFor(repositoryId ?? '').selectedNumber)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // #930 (bug caught by the live-check driver, first real build of this story): `defaultSize`
  // is ALSO `react-resizable-panels`' own double-click-reset target (`onDocumentDoubleClick`
  // reads `itemWithDefaultSize.constraintProps.defaultSize` live, from whatever this Panel's own
  // `defaultSize` prop currently evaluates to) -- binding it to the layout store's reactively-
  // subscribed `widthPx` meant every drag's own `onResize` -> `setWidth` -> re-render cycle silently
  // moved the "reset to" target to wherever the panel already was, making double-click reset a
  // no-op. `defaultSize` below stays pinned at the true default; the panel's INITIAL render
  // honours a remembered non-default width via one imperative `resize()` call instead (same
  // `panelRef`/`useLayoutEffect` pattern `App.tsx`'s own `rightPaneRef` uses for its collapse/
  // expand), applied once per mount via `hasAppliedInitialWidth`, never on every Project switch.
  // Gate-fix (relaunch-restore race, caught via code review of the #930 onResize-persists
  // redesign): `useRef`'s own initial-value argument is evaluated on every render but only ever
  // KEPT from this component's FIRST render -- which happens strictly BEFORE any layout effect
  // (child or parent) can fire. Reading the store FRESH, inside the effect below, would race the
  // `ResizablePanel`'s own child layout effect, which reports its very first `onResize` using
  // its hardcoded `defaultSize` (320) before this parent effect ever runs (children's layout
  // effects run before their parent's) -- now that `setWidth` persists unconditionally, that
  // premature `onResize(320)` would both clobber the live `widthPx` back to the default AND
  // schedule a write of 320, so this effect's own `!== DEFAULT` check would then (wrongly) see
  // the already-clobbered 320 and skip calling `resize()` at all, permanently erasing whatever
  // non-default width the user actually had saved, on every single relaunch. Capturing the
  // value here instead reads it before that race can ever begin.
  const initialWidthPxRef = useRef(usePullRequestsLayoutStore.getState().widthPx)
  const panelRef = useRef<PanelImperativeHandle>(null)
  const hasAppliedInitialWidth = useRef(false)
  useLayoutEffect(() => {
    if (!repositoryId) {
      // Gate-fix (L1, caught live 2026-10-18): used to return here with no reset, so if every
      // Project were removed and a new one added later, `hasAppliedInitialWidth.current` was
      // already (permanently) `true` from the very first mount and the remembered width was
      // never re-applied to the newly-added Project's own panel.
      hasAppliedInitialWidth.current = false
      return
    }
    if (hasAppliedInitialWidth.current) return
    hasAppliedInitialWidth.current = true
    const persistedWidthPx = initialWidthPxRef.current
    if (persistedWidthPx !== PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX) {
      panelRef.current?.resize(persistedWidthPx)
    }
  }, [repositoryId])

  // Issue #930 gate-fix (caught live 2026-10-17, round 2): the heading row's own wrapper used to
  // track the layout store's `widthPx` (an integer read off `react-resizable-panels`' own
  // `onResize`). Matching the panel's real rendered WIDTH turned out not to be enough on its
  // own: the drag-region header row above has its own `px-4` horizontal padding, while the
  // `ResizablePanelGroup`/panel below it has none, so this wrapper's own LEFT edge sits ~12px
  // to the right of the panel's real left edge. Pinning the wrapper's width to the panel's
  // width alone still left its RIGHT edge ~12px past the panel's real right edge -- invisible
  // while the Select had slack to spare, but the moment the column got narrow enough that the
  // Select had to shrink to fill the wrapper, it shrank to fill the WRAPPER's edge, not the
  // panel's, landing the Project selector exactly that ~12px past the real column (confirmed
  // live: the overflow amount didn't change between runs, consistent with a fixed geometry
  // offset rather than any timing/rounding drift). Measuring BOTH elements' own
  // `getBoundingClientRect()` and computing this wrapper's width as the exact gap between the
  // panel's real right edge and this wrapper's own real left edge removes the padding
  // mismatch as a variable entirely: wrapperRight is always, by construction, panelRight.
  const panelElementRef = useRef<HTMLDivElement | null>(null)
  const headerWrapperRef = useRef<HTMLDivElement | null>(null)
  const groupElementRef = useRef<HTMLDivElement | null>(null)
  const [listColumnWidthPx, setListColumnWidthPx] = useState(
    () => usePullRequestsLayoutStore.getState().widthPx
  )
  // Gate-fix (M6, caught live 2026-10-18, re-diagnosed): a STATIC `maxSize="50%"` and a STATIC
  // `minSize={280}` (pixels) are a straight-up numeric conflict whenever the Group's own width
  // drops below 560px (2 x 280) -- read `react-resizable-panels`' own per-item clamp (`Me` in
  // the built dist): it clamps UP to `minSize` first, but then runs an UNCONDITIONAL
  // `Math.min(maxSize, size)` afterward, so `maxSize` always wins a genuine conflict, for every
  // trigger (passive container resize, drag, arrow-key, and this component's own prior
  // imperative `panelRef.current?.resize(280)` attempt -- confirmed live: that call went
  // through the exact same clamp and landed back at `maxSize`'s resolved pixel value every
  // time, a no-op that also corrupted the panel's internally-stored percentage for whatever
  // width was current at the time, surfacing later as a stuck/wrong width once the real window
  // was restored). The only way to make the 280px floor actually win is to never let the two
  // constraints conflict in the first place: compute `maxSize` as a live percentage of the
  // Group's OWN measured width, floored so it can never resolve below the 280px minimum.
  // `Panel`'s own `useLayoutEffect` re-registers (and the library recomputes) whenever its
  // `maxSize` prop changes, so this needs no imperative nudge of its own.
  const [listMaxSizePercent, setListMaxSizePercent] = useState(50)
  useLayoutEffect(() => {
    const panelEl = panelElementRef.current
    const wrapperEl = headerWrapperRef.current
    const groupEl = groupElementRef.current
    if (!panelEl || !wrapperEl || !groupEl) return
    const measure = () => {
      const panelRect = panelEl.getBoundingClientRect()
      const wrapperLeft = wrapperEl.getBoundingClientRect().left
      setListColumnWidthPx(panelRect.right - wrapperLeft)
      const groupWidth = groupEl.getBoundingClientRect().width
      if (groupWidth > 0) {
        const minPercentForFloor = (PULL_REQUESTS_LIST_MIN_WIDTH_PX / groupWidth) * 100
        setListMaxSizePercent(Math.max(50, minPercentForFloor))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panelEl)
    observer.observe(groupEl)
    return () => observer.disconnect()
  }, [repositoryId])

  // High remediation (a11y, round 3): round 2's tasks.md T028 claimed this was already fixed --
  // it was never written at all (confirmed: zero commits touched this file for it). Matches
  // `SettingsScreen.tsx`'s exact established pattern: a real `<h2>`, `tabIndex={-1}` so it
  // accepts programmatic focus without joining the Tab order, focused once on mount so entering
  // this view from the left-nav lands keyboard/screen-reader users somewhere meaningful instead
  // of leaving focus on the nav button that was just activated.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const selectedRepositoryName = repositories.find((repo) => repo.id === repositoryId)?.name

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Issue #500: this row used to have neither `drag-region` nor `no-drag-region` --
          `App.tsx`'s permanent full-width drag strip covers these pixels by default, so the
          repository Select (with no override) was inside a drag region and never received its
          click. Matches `SettingsScreen.tsx`/`SessionList.tsx`'s drag/no-drag pattern, with a
          corner spacer as in `ChatHeader.tsx`/`App.tsx`'s own strip -- spec 013 gate remediation
          (Medium): this view mounts the right-pane shell too (the chat panel's content swaps,
          the session-list/right-pane panels stay), so `reservesWindowControls` must be `false`
          whenever the right pane shell is the one holding that corner (FR-011, "exactly once"),
          the same prop `ChatPane.tsx` takes. */}
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-4">
        {/* Issue #930 (2026-10-16 decision): this wrapper's own width tracks the resizable list
            column's real rendered width (`listColumnWidthPx`, measured off the panel's own DOM
            element -- see the `ResizeObserver` effect above) so the heading and Project selector
            truncate in step with it, instead of only shrinking at the app's unrelated 360px
            window-wide floor (#500's original fix, which this keeps as the Select's own inner
            `min-w-0 shrink` fallback). Gate-fix (H2, caught live 2026-10-18): no `overflow-hidden`
            here -- `min-w-0` on both this wrapper and its children already truncates everything
            that needs it, and `overflow-hidden` was additionally clipping the Project selector's
            own focus ring on its right edge, where the wrapper's width is now pinned flush
            against the panel's real edge with no slack to spare. */}
        <div ref={headerWrapperRef} className="flex min-w-0 shrink-0 items-center gap-2" style={{ width: repositoryId ? listColumnWidthPx : undefined }}>
          {/* Gate-fix (M1, caught live round 2 2026-10-18, test-reviewer Medium): the heading
              used to shrink/truncate ("Pull reque…" at the default 320px column) while the
              Project selector's own `w-56` held its full width unconditionally -- reversed:
              the heading never truncates (`shrink-0`), the selector gets `min-w-0 flex-1` (no
              fixed width) so IT absorbs the squeeze and truncates instead, matching its own
              `line-clamp-1` `SelectValue` and Radix `Tooltip` (gate-fix M3) for the full name. */}
          <h2 ref={headingRef} tabIndex={-1} className="shrink-0 text-sm font-semibold outline-none">
            Pull requests
          </h2>
          {repositoryId && (
            <Select value={repositoryId} onValueChange={(value) => openPullRequests(value)}>
              {/* Quality-gate remediation (code-reviewer, Medium): the chat panel can shrink to
               * 360px (`App.tsx`'s `minSize={360}`); without `min-w-0`/`shrink` this trigger
               * held its full width and pushed the trailing corner spacer past the window's right
               * edge, where it was clipped -- the Select's own right end then sat back under the
               * window buttons, the exact dead-click conflict #500 removed. `min-w-0 flex-1` lets
               * it shrink and truncate instead (the trigger's inner `SelectValue` already
               * `line-clamp-1`s, per `select.tsx`).
               * Gate-fix (M3, caught live 2026-10-18): the Project name used to be a bare
               * `title` attribute (a native browser tooltip, inconsistent styling, no delay/
               * dismiss control, invisible to touch) -- a Radix `Tooltip` matches the Filters
               * button's own established pattern (`aria-describedby={undefined}` stops Radix
               * doubling the announcement against the trigger's own `aria-label`, which now
               * reads "Project: <name>" -- "Repository" was never the UI's own word for this,
               * `CONTEXT.md`'s own Project entry is).
               * Gate-fix (L2, caught live round 2 2026-10-18): `side="right"` -- the default
               * `top` placement overlapped the Filter tabs row directly below this header. */}
              <Tooltip>
                <TooltipTrigger asChild aria-describedby={undefined}>
                  <SelectTrigger
                    size="sm"
                    aria-label={selectedRepositoryName ? `Project: ${selectedRepositoryName}` : 'Project'}
                    className="no-drag-region min-w-0 flex-1"
                  >
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">{selectedRepositoryName ?? 'Project'}</TooltipContent>
              </Tooltip>
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
        </div>
        {reservesWindowControls && (
          <div
            aria-hidden
            className="no-drag-region ml-auto shrink-0"
            style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }}
          />
        )}
      </div>
      {!repositoryId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Add a repository to browse its pull requests.
        </div>
      ) : (
        <ResizablePanelGroup
          elementRef={groupElementRef}
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          {/* Issue #930 (2026-10-16 decision): 280px up to half the view, default/remembered
              320px, one width for every Project. Native to `react-resizable-panels` 4.14.1:
              `defaultSize`/`minSize` as plain numbers are pixels, `maxSize` as a percentage
              string is relative to the Group's own measured width -- no manual px/percent
              conversion needed. Double-click-to-reset and arrow-key resize on the handle are
              both this library's own built-in `Separator` behaviour (`disableDoubleClick`
              defaults to `false`; keyboard handling needs no code here -- `App.tsx`'s own
              comment records how wrapping the Separator once broke it by accident).
              `defaultSize` is pinned at the fixed default (not the live `widthPx` state) so
              double-click-reset keeps resetting to 320px even after a drag; the `panelRef`
              effect above applies a remembered non-default width once, imperatively.
              `maxSize` is `listMaxSizePercent`, not a static "50%" -- see the M6 gate-fix
              comment above the measuring effect for why a static percentage genuinely
              conflicts with the 280px floor below a 560px Group width. */}
          {/* Gate-fix (final root cause, caught live via tagged call-site instrumentation):
              three prior rounds (M3's coordinate-proximity check, round 4's capture-phase
              before/after width snap, `onLayoutChanged`'s own `isUserInteraction` gate) all
              tried to detect "was this interaction ours" from DOM/event signals that turned out
              unreliable -- `onDoubleClickCapture` always observed the library's OWN capture-
              phase reset having ALREADY applied (it runs on `document`, ahead of any React
              component handler, so `before` and `after` were both already ~the default,
              permanently defeating the snap-to-default gate: confirmed live, zero
              `resetToDefault` calls fired in an entire run) and `onLayoutChanged`'s own
              `isUserInteraction` flag was confirmed live to fire true for some genuine resets
              on THIS group and not others, for the identical interaction. `onResize`
              (`PanelSize.inPixels`), by contrast, fired RELIABLY and ACCURATELY for every single
              case observed live -- a drag, an arrow-key resize, the library's own internal
              double-click reset, AND a passive reflow cascading down from the OUTER session-
              list handle's own resize (confirmed: that cascade's real pixel width showed up
              here, correctly, on every occurrence) -- it is the one source of truth for "what is
              this panel's real width right now", for ANY reason it changed. `setWidth` itself
              now owns persisting it (debounced ~300ms, `pull-requests-layout-store.ts`), so the
              persisted value can never go stale behind a sibling's own resize again; a drag's
              many intermediate `onResize` ticks still coalesce to one write via that same
              debounce, exactly as the removed `onLayoutChanged`-gated `commit()` did. */}
          <ResizablePanel
            id="pull-requests-list"
            panelRef={panelRef}
            elementRef={panelElementRef}
            defaultSize={PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX}
            minSize={PULL_REQUESTS_LIST_MIN_WIDTH_PX}
            maxSize={`${listMaxSizePercent}%`}
            className="overflow-hidden"
            onResize={(size) => usePullRequestsLayoutStore.getState().setWidth(size.inPixels)}
          >
            <PullRequestList repositoryId={repositoryId} />
          </ResizablePanel>
          <ResizableHandle withHandle aria-label="Resize pull request list" />
          <ResizablePanel id="pull-requests-detail">
            <div className="h-full min-w-0 overflow-hidden">
              {selectedNumber !== null ? (
                <PullRequestDetail repositoryId={repositoryId} number={selectedNumber} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  Select a pull request to view its details.
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}
