// The top-level Pull requests view (specs/003-pull-request-management FR-001, T012): a
// repository dropdown over a two-column layout -- the filterable list (PullRequestList.tsx) and
// the selected pull request's detail (PullRequestDetail.tsx) -- scoped to the repository chosen
// here, written back to the shared `view-store.ts` so the choice survives switching away and
// back (research.md decision 7).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  const panelRef = useRef<PanelImperativeHandle>(null)
  const hasAppliedInitialWidth = useRef(false)
  useLayoutEffect(() => {
    if (!repositoryId || hasAppliedInitialWidth.current) return
    hasAppliedInitialWidth.current = true
    const persistedWidthPx = usePullRequestsLayoutStore.getState().widthPx
    if (persistedWidthPx !== PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX) {
      panelRef.current?.resize(persistedWidthPx)
    }
  }, [repositoryId])

  // Issue #930 gate-fix (caught live 2026-10-17): the heading row's own wrapper used to track
  // the layout store's `widthPx`, which `onResize` feeds from `react-resizable-panels`' own
  // `element.offsetWidth` -- an INTEGER, rounded read. The real panel box the test (and the eye)
  // measures via `getBoundingClientRect()` is a subpixel float, and at some drag positions the
  // rounded `widthPx` this wrapper rendered at was wider than the panel's true fractional width,
  // pushing the Project selector's own right edge past the real column's right edge even though
  // it stayed inside this wrapper's (slightly too generous) own bounds. Measuring the panel's
  // actual DOM element directly -- the same element and the same `getBoundingClientRect()` the
  // live check reads -- makes this wrapper's width byte-identical to the real column, every time.
  const panelElementRef = useRef<HTMLDivElement | null>(null)
  const [listColumnWidthPx, setListColumnWidthPx] = useState(
    () => usePullRequestsLayoutStore.getState().widthPx
  )
  useLayoutEffect(() => {
    const el = panelElementRef.current
    if (!el) return
    const measure = () => setListColumnWidthPx(el.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
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
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
        {/* Issue #930 (2026-10-16 decision): this wrapper's own width tracks the resizable list
            column's real rendered width (`listColumnWidthPx`, measured off the panel's own DOM
            element -- see the `ResizeObserver` effect above) so the heading and Project selector
            truncate in step with it, instead of only shrinking at the app's unrelated 360px
            window-wide floor (#500's original fix, which this keeps as the Select's own inner
            `min-w-0 shrink` fallback). */}
        <div className="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden" style={{ width: repositoryId ? listColumnWidthPx : undefined }}>
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
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={(_layout, meta) => usePullRequestsLayoutStore.getState().commit(meta.isUserInteraction)}
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
              effect above applies a remembered non-default width once, imperatively. */}
          <ResizablePanel
            id="pull-requests-list"
            panelRef={panelRef}
            elementRef={panelElementRef}
            defaultSize={PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX}
            minSize={PULL_REQUESTS_LIST_MIN_WIDTH_PX}
            maxSize="50%"
            className="overflow-hidden border-r border-divider"
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
