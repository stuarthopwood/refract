// The pane header (spec 013 FR-007/FR-008/FR-011, issue://394): a single title row with a Close
// button for exactly one open panel, or an ARIA tabs pattern bar for two or more. Either way it
// reserves the window-controls corner so no pane control ever sits under the native minimise/
// maximise/close buttons (FR-011) -- the same trailing spacer `ChatHeader.tsx` uses while it owns
// that corner instead.
//
// The tab bar is hand-rolled, not the shared `Tabs` primitive (`components/ui/tabs.tsx`): each
// tab needs its own close button. PR1 kept each close button inside a wrapping `<span>` alongside
// its tab, both direct children of `role="tablist"` -- harmless in practice (the pattern the W3C
// ARIA working group tested and confirmed accessible across NVDA/JAWS/VoiceOver, w3c/aria#2322),
// but still flagged by axe-core's static `aria-required-children` rule, and deferred to PR2
// (tasks.md T028's own note) since a second real panel was needed to reach it at all.
//
// PR2 round 1: the tablist's own children became ONLY `role=tab` buttons, with every close button
// a DOM sibling outside it -- verified by direct DOM query (`tablist` children are only
// `role=tab`), not by running axe, and a real screen reader pass (NVDA/JAWS/VoiceOver) was not
// performed in this environment; both recorded as open live-check items (issue #650), not claimed.
//
// PR2 round 3 (spec 013's settled rule, corrected mid-round-2 before pushing round 2's design:
// EVERY tab keeps its own close and live count -- round 2's withdrawn icon-only/activation-only
// compact design for inactive tabs is NOT this spec): round 1's `min-w-0 shrink` let a tab's own
// measured box (used to position its close button) shrink below content that does not shrink --
// the icon, and the close button's own reserved space -- so at the pane's 320px default with
// three panels the close button could land ON TOP OF the icon (WCAG 2.5.8), and every label
// clipped to near nothing with no Tooltip to recover the name (FR-026). The actual shortfall is
// structural, not fixable by trimming any one tab further: the pane header's own top row must
// also reserve the window-controls corner (FR-011), and at the 240px floor with three panels the
// row has only ~122px left for three tabs that each need an icon, a close button and (today) a
// label -- not enough even fully truncated.
//
// Fixed by moving the tab strip into its OWN row, below the row that reserves the window-controls
// corner (the single-panel title row above is unaffected and still carries that reservation).
// Freed from competing with the caption-button spacer, the strip's available width is `pane width
// - 16px` (this row's own `px-2`) instead of `pane width - 118px` -- live-measured at the 240px
// floor with three panels: `clientWidth` 224px (see the geometry table in tasks.md). The
// close-button reserve was tightened from `pr-8` (32px, the round-1/round-2 value) to `pr-7`
// (28px: `CLOSE_BUTTON_PX` 24 + its own 4px inset, the button's real drawn footprint, not an extra
// margin on top of it). Round 4 gate remediation (High, Code3/A11y3/Verif3 converged): a tab's
// live count has its NUMBER (`tabular-nums`, `shrink-0` -- never shrinks, so the figure itself
// stays legible, FR-012) and its trailing WORD (` running`, `min-w-0 truncate` -- gives way first,
// same priority as `+a -d`'s own lack of a separate word); the label gives up space before the
// count's word does (`shrink-[100]` against the word's plain `shrink`). Every tab's floor is
// therefore ~56px without a count, ~58px with one and both parts fully truncated -- three tabs'
// worst case with a two-digit running count is ~194px against 224px available at the 240px floor
// (30px slack; see the recomputed geometry table in tasks.md). Live-verified with a REAL count
// change (temporary local-only dev-store injection in the scratch instance only, reverted before
// this push, never shipped): `running` set to 1 then 12 on the actual focused Session while the
// strip was already squeezed at the 240px floor -- both digit counts rendered with zero overflow
// and every tab's own close button stayed inside that tab's own rect.
//
// Round 4 also fixed the bug that live count change was exposing: the `ResizeObserver` from round
// 3 watched only the tablist container, which -- once the strip is already squeezed and the
// tablist's own outer width is pinned to its flex parent rather than driven by its children's
// natural size -- never fires when one tab's internal content changes length without changing the
// tablist's own total width (confirmed live: the total stayed 224px before and after the count
// change, redistributed among tabs, while the single tablist-level observer would have missed it
// entirely). Fixed: every open tab's own element is observed too, not just the tablist, so any
// one tab's own resize now triggers a full `closePositions` recompute.
//
// Every tab -- selected or not -- renders its icon, a truncating label, a truncating count and its
// own close button (restoring round 1's per-tab close, but still a DOM sibling of the tablist via
// an absolutely-positioned overlay per open tab, keeping the tablist's own children limited to
// `role=tab` so axe's `aria-required-children` rule stays satisfied); every tab also carries its
// own Tooltip (full name plus count) for sighted users when its label visually truncates, since
// the accessible name (the tab's own text content) is never actually truncated by the CSS
// ellipsis regardless -- the tooltip's own content is `aria-hidden` (round 4, Low) so Radix's
// usual `aria-describedby` wiring does not announce that same name a second time. Clicking a
// tab's own body selects it; clicking its close button closes it directly, selected or not, with
// no select-first step. Delete on a focused tab -- selected or not -- still closes it directly,
// unchanged from round 1/2 (`handleTabKeyDown` reads the keystroke from the tab button itself,
// never from a close overlay). Only the ACTIVE tab's own close button is a Tab stop (`tabIndex=0`,
// round 4, Medium A11y3: every close button being a Tab stop added N of them to the tab order,
// jumping back to the leftmost X after the rightmost selected tab); inactive tabs' close buttons
// stay reachable by mouse only, and also answer Delete directly if somehow focused programmatically.
import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRightPaneStore } from '@/state'
import { formatPanelCount, getPanelDescriptor, usePanelCount, type PanelId } from './panel-registry'
import { closeHostedPanel } from './hosted-panel-actions'

// Gate remediation: the rail sits in its own 40px (`2.5rem`) column to the right of the pane, but
// the native caption-button cluster is wider than that (about 138px) and overlaps both the rail's
// top (handled by `IconRail.tsx`'s own vertical spacer) and the pane header's own top-right corner
// -- only the REMAINING width past the rail needs reserving here, or the pane would reserve the
// full caption width a second time. Clamped at 0 so a window narrower than the caption cluster
// never produces a negative width.
const WINDOW_CONTROLS_SPACER_STYLE = { width: 'max(0px, calc(100vw - env(titlebar-area-width, 100vw) - 2.5rem))' }
// Inset (negative offset), matching `RightPaneShell.tsx`'s own content-focus ring: an outset ring
// drawn outside this row's `overflow` wrapper gets its top/bottom (and the first tab's left edge)
// clipped, since the wrapper is exactly as tall as a tab (gate remediation, round 1).
const FOCUS_VISIBLE = 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'
// 24px minimum target (FR-026/WCAG 2.5.8), matching `icon-sm`'s own footprint.
const CLOSE_BUTTON_PX = 24
const CLOSE_BUTTON_INSET_PX = 4

interface PanelTabBarProps {
  /** The focused chat pane's Session -- feeds a per-Session panel's live count (data-model.md
   * `getPanelCount`), independent of which Session that panel's own content is bound to. */
  sessionId: string | null
}

export function PanelTabBar({ sessionId }: PanelTabBarProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const openPanel = useRightPaneStore((s) => s.openPanel)
  const tabRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})
  // Gate remediation (Sec2, Low): scoped to this component's own rendered subtree, so a future
  // second `PanelTabBar` instance (there is only ever one today) could never steal focus from
  // this one's `[data-panel-close]` query. Shared by both render branches below.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Round 3: every open tab draws its own close button, so every tab's own position is tracked
  // (restoring round 1's map, which round 2 had narrowed to just the active tab). Round 4 gate
  // remediation (High, Code3/A11y3/Verif3 converged): observing only the tablist container missed
  // a live count changing length while the strip is already squeezed -- once the tablist's own
  // width is pinned to its flex parent (not driven by its children's natural size), a tab growing
  // or shrinking internally (its count's digit count changing) does not change the tablist's own
  // border-box size, so that single observer never fires and a stale `closePositions` entry leaves
  // a close button sitting over the WRONG tab (a click meant to select one tab could close its
  // neighbour instead, WCAG 2.5.8). Fixed: observe every open tab's own element too, not just the
  // tablist -- any one tab's own resize now triggers a full recompute, re-subscribed whenever
  // `openPanelIds` changes.
  const [closePositions, setClosePositions] = useState<Partial<Record<PanelId, { left: number; top: number }>>>({})

  const recomputeClosePositions = () => {
    const next: Partial<Record<PanelId, { left: number; top: number }>> = {}
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (!el) continue
      next[id] = {
        left: el.offsetLeft + el.offsetWidth - CLOSE_BUTTON_PX - CLOSE_BUTTON_INSET_PX,
        top: el.offsetTop + (el.offsetHeight - CLOSE_BUTTON_PX) / 2
      }
    }
    setClosePositions(next)
  }

  useLayoutEffect(() => {
    recomputeClosePositions()
    const tablist = wrapRef.current?.querySelector('[role="tablist"]')
    if (!tablist) return
    const observer = new ResizeObserver(() => recomputeClosePositions())
    observer.observe(tablist)
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanelIds])

  // Gate remediation (round 2, Code2/Verif2): `scrollIntoView` scrolls every scrollable ancestor
  // needed to bring the element into view, including `RightPaneShell`'s own `overflow-hidden`
  // region and the `ResizablePanel` itself -- both still technically "scrollable containers" to
  // the browser even though neither is meant to scroll, so a stray call could shift the whole pane
  // sideways instead of only this row's own strip. Adjusts `wrapRef`'s own `scrollLeft` directly
  // instead. Also returns early while the pane is collapsed, when this row's measurements (and the
  // whole point of scrolling it into view) do not mean anything yet.
  useLayoutEffect(() => {
    if (!activePanelId) return
    if (!useRightPaneStore.getState().open) return
    const wrap = wrapRef.current
    const tab = tabRefs.current[activePanelId]
    if (!wrap || !tab) return
    const tabLeft = tab.offsetLeft
    const tabRight = tab.offsetLeft + tab.offsetWidth
    if (tabLeft < wrap.scrollLeft) wrap.scrollLeft = tabLeft
    else if (tabRight > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = tabRight - wrap.clientWidth
  }, [activePanelId, openPanelIds])

  if (openPanelIds.length === 1) {
    const id = openPanelIds[0]
    const descriptor = id ? getPanelDescriptor(id) : undefined
    if (!id || !descriptor) return null
    return (
      <div ref={wrapperRef} className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
        <h2 id="right-pane-panel-title" className="min-w-0 truncate text-sm font-semibold">
          {descriptor.name}
        </h2>
        <div className="no-drag-region ml-auto flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-panel-close
                aria-label={`Close ${descriptor.name} panel`}
                onClick={() => closeHostedPanel(id)}
              >
                <XIcon aria-hidden className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Close ${descriptor.name} panel`}</TooltipContent>
          </Tooltip>
          <div aria-hidden className="shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
        </div>
      </div>
    )
  }

  function focusTab(id: PanelId): void {
    tabRefs.current[id]?.focus()
  }

  // Gate remediation (High, round 1): closing a tab used to focus a neighbour computed
  // independently of `right-pane-store.ts`'s own `closePanel`, which could leave focus on a tab
  // that `aria-selected=false` while a DIFFERENT tab's content showed. Now `closePanel` itself
  // picks the neighbour (see its own doc comment), and this function simply reads that choice back
  // -- there is exactly one source of truth for "which tab is next" instead of two that can drift.
  // `closeHostedPanel`'s own rail/chip fallback is suppressed (`skipFocusFallback`) whenever
  // another panel remains, so its `requestAnimationFrame` can't race this one and steal focus back
  // out. This function only ever runs from the tab-bar branch below, which never renders with
  // fewer than two open panels, so closing one here always leaves at least one behind.
  function closeTab(id: PanelId): void {
    const remainingCount = openPanelIds.length - 1
    closeHostedPanel(id, { skipFocusFallback: true })
    if (remainingCount === 1) {
      // Drops into the single-panel title-row branch above on the next render; focus its Close
      // button (not a tab ref, which no longer exists once the tablist itself unmounts).
      requestAnimationFrame(() => {
        wrapperRef.current?.querySelector<HTMLElement>('[data-panel-close]')?.focus()
      })
      return
    }
    const nextId = useRightPaneStore.getState().activePanelId
    if (nextId) requestAnimationFrame(() => focusTab(nextId))
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: PanelId): void {
    const index = openPanelIds.indexOf(id)
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const nextId = openPanelIds[(index + delta + openPanelIds.length) % openPanelIds.length]
      if (!nextId) return
      openPanel(nextId)
      focusTab(nextId)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const nextId = event.key === 'Home' ? openPanelIds[0] : openPanelIds[openPanelIds.length - 1]
      if (!nextId) return
      openPanel(nextId)
      focusTab(nextId)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(id)
    }
  }

  return (
    <div className="flex shrink-0 flex-col">
      {/* Row 1: reserves the window-controls corner only (FR-011) -- the tab strip below needs
          none of this width, freeing it for the tabs themselves (the round-2 shortfall's root
          cause). No title text here: the active tab's own label already names the pane. */}
      <div aria-hidden className="drag-region flex h-10 items-center px-2">
        <div className="no-drag-region ml-auto shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
      </div>
      {/* Row 2: the tab strip, now with the whole pane width (less this row's own padding) to
          itself. */}
      <div ref={wrapperRef} className="no-drag-region flex h-10 shrink-0 items-center gap-1 border-t border-border px-2">
        <div ref={wrapRef} className="relative flex min-w-0 flex-1 items-center overflow-x-auto">
          <div role="tablist" aria-label="Open panels" className="flex min-w-0 items-center gap-0.5">
            {openPanelIds.map((id) => (
              <TabButton
                key={id}
                id={id}
                selected={id === activePanelId}
                sessionId={sessionId}
                tabRef={(el) => {
                  tabRefs.current[id] = el
                }}
                onSelect={() => openPanel(id)}
                onKeyDown={(event) => handleTabKeyDown(event, id)}
              />
            ))}
          </div>
          {openPanelIds.map((id) => {
            const position = closePositions[id]
            const descriptor = getPanelDescriptor(id)
            if (!position || !descriptor) return null
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    tabIndex={id === activePanelId ? 0 : -1}
                    data-panel-close
                    aria-label={`Close ${descriptor.name} panel`}
                    style={{ position: 'absolute', left: position.left, top: position.top }}
                    className={cn(
                      'inline-flex size-6 items-center justify-center rounded text-current hover:bg-foreground/10',
                      FOCUS_VISIBLE
                    )}
                    onClick={() => closeTab(id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Delete') {
                        event.preventDefault()
                        closeTab(id)
                      }
                    }}
                  >
                    <XIcon aria-hidden className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {`Close ${descriptor.name} panel`}
                  <Kbd>Delete</Kbd>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface TabButtonProps {
  id: PanelId
  selected: boolean
  sessionId: string | null
  tabRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function TabButton({ id, selected, sessionId, tabRef, onSelect, onKeyDown }: TabButtonProps) {
  const descriptor = getPanelDescriptor(id)
  const count = usePanelCount(id, sessionId)
  if (!descriptor) return null
  const Icon = descriptor.icon
  const countText = count ? formatPanelCount(count) : undefined
  const fullLabel = `${descriptor.name}${countText ? ` ${countText}` : ''}`
  // Round 4 gate remediation (High, Verif3/Code3, Stuart's "every tab has its own count" rule):
  // round 3 made the whole count span `min-w-0 shrink truncate`, so at the 240px floor with three
  // panels a running count could shrink all the way to an ellipsis, leaving colour as the only
  // signal (FR-012). Split the count into its NUMBER (`tabular-nums`, `shrink-0` -- never shrinks,
  // so the figure itself is always legible) and the trailing WORD/sign (` running`, `min-w-0
  // truncate` -- gives way first). `+a -d` has no separate word, so its whole text stays
  // `shrink-0` too. The label gives up space before the count's word does (`shrink-[100]` against
  // the word's plain `shrink`), since the count is the more load-bearing of the two once space is
  // tight.
  const countNumber = count ? (count.kind === 'running' ? String(count.value) : `+${count.additions} -${count.deletions}`) : undefined
  const countWord = count?.kind === 'running' ? ' running' : ''

  const button = (
    <button
      ref={tabRef}
      role="tab"
      id={`panel-tab-${id}`}
      aria-selected={selected}
      aria-controls={selected ? `panel-content-${id}` : undefined}
      tabIndex={selected ? 0 : -1}
      className={cn(
        'relative inline-flex h-7 min-w-14 shrink items-center gap-1 rounded-md px-2 pr-7 text-sm font-medium',
        FOCUS_VISIBLE,
        selected
          ? 'bg-muted text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 shrink-[100] truncate">{descriptor.name}</span>
      {countText && (
        <span className={cn('inline-flex min-w-0 shrink items-baseline', count?.kind === 'running' ? 'text-state-working' : undefined)}>
          <span className="shrink-0 tabular-nums">{countNumber}</span>
          {countWord && <span className="min-w-0 truncate">{countWord}</span>}
        </span>
      )}
    </button>
  )

  // Round 3: every tab carries a Tooltip with its full name and count -- a sighted-user recovery
  // path when the label visually truncates (the accessible name, this button's own text content,
  // is never actually truncated by the CSS ellipsis regardless of how little of it is visible).
  // Round 4 (Low, Verif3): the tooltip repeated the accessible name verbatim via Radix's own
  // `aria-describedby` wiring on the trigger -- `aria-hidden` on this tooltip's own content keeps
  // it a sighted-only recovery path, since a screen reader already has the full name from the
  // tab's own text content.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent aria-hidden>{fullLabel}</TooltipContent>
    </Tooltip>
  )
}
