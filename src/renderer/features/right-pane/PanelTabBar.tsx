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
// PR2: the tablist's own children are now ONLY `role=tab` buttons. Every close button lives in a
// separate overlay, a DOM sibling of the tablist (not a descendant), positioned per tab from that
// tab button's own measured `offsetLeft`/`offsetWidth`/`offsetTop`/`offsetHeight` -- both the
// tablist and the overlay are children of the same `relative` wrapper. A `ResizeObserver` watches
// every tab button (a tab's own width changes when its live count's digit count changes, shifting
// its own close button and every later tab's) and recomputes every position on any of their
// resizes, and on `openPanelIds` changes (a tab closing or opening shifts everyone after it). Each
// close button's own `tabIndex` stays synced to the roving-tabindex state (0 only when its tab is
// the active one, -1 otherwise) exactly as before, so it still never joins the arrow-key cycle and
// Tab still only ever adds one extra stop for the whole bar.
//
// Known, accepted trade-off: grouping every tab before every close button in document order changes
// a screen reader's browse-mode reading order ("tab 1, tab 2, ... close 1, close 2" instead of the
// previous "tab 1, close 1, tab 2, close 2"); Tab-key interaction order is unaffected, since
// `tabIndex=-1` elements are never a Tab stop regardless of DOM position. Verified by DOM query
// only (the tablist's own children are queried directly and confirmed to be only `role=tab`) --
// axe itself was not run, and a real screen reader pass (NVDA/JAWS/VoiceOver) was not performed in
// this environment either; both are recorded as open live-check items (issue #650), not claimed.
//
// Gate remediation (PR2's own gate, round 1): the tab strip used to overflow at the pane's default
// 320px width (`shrink-0` on every tab, plus a window-controls spacer that double-reserved the
// rail's own 40px) -- fixed by letting tabs shrink and truncate their label, trimming the rail's
// width out of the spacer, and scrolling the active tab into view defensively. Focus rings on tabs
// and close buttons were also clipped by the scrolling wrapper's own height (an outset
// `outline-offset-2` drew outside it) -- fixed by insetting the ring, matching the pane content
// region's own `outline-offset-[-2px]` convention. Closing a tab used to leave keyboard focus on a
// DIFFERENT tab from the one the store made active (`closeTab` computed its own neighbour index
// independently of `right-pane-store.ts`'s own choice) -- fixed by making the store's own
// `closePanel` activate the neighbour (not always the last tab) and having `closeTab` read that
// choice back from the store instead of recomputing it, with `closeHostedPanel`'s own rail/chip
// fallback suppressed via `skipFocusFallback` whenever another panel remains open so the two
// focus-restoration paths can't race.
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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

interface ClosePosition {
  left: number
  top: number
}

export function PanelTabBar({ sessionId }: PanelTabBarProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const openPanel = useRightPaneStore((s) => s.openPanel)
  const tabRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})
  const [closePositions, setClosePositions] = useState<Partial<Record<PanelId, ClosePosition>>>({})

  const recomputeClosePositions = useCallback(() => {
    const next: Partial<Record<PanelId, ClosePosition>> = {}
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (!el) continue
      next[id] = {
        left: el.offsetLeft + el.offsetWidth - CLOSE_BUTTON_PX - CLOSE_BUTTON_INSET_PX,
        top: el.offsetTop + (el.offsetHeight - CLOSE_BUTTON_PX) / 2
      }
    }
    setClosePositions(next)
  }, [openPanelIds])

  useLayoutEffect(() => {
    recomputeClosePositions()
    if (openPanelIds.length < 2) return
    const observer = new ResizeObserver(() => recomputeClosePositions())
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [openPanelIds, recomputeClosePositions])

  // Gate remediation: scrolls the active tab into view defensively -- `TabButton`'s own
  // `min-w-0 shrink` plus truncation should mean the strip never actually overflows its wrapper at
  // any pane width this spec supports (240-520px, up to 3 tabs), but a future panel or an unusually
  // long name could still produce a sliver of overflow, and this costs nothing when it doesn't.
  useLayoutEffect(() => {
    if (!activePanelId) return
    tabRefs.current[activePanelId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePanelId, openPanelIds])

  if (openPanelIds.length === 1) {
    const id = openPanelIds[0]
    const descriptor = id ? getPanelDescriptor(id) : undefined
    if (!id || !descriptor) return null
    return (
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
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
  // `closeHostedPanel`'s own rail/chip fallback is suppressed (`skipFocusFallback`) whenever another
  // panel remains, so its `requestAnimationFrame` can't race this one and steal focus back out.
  function closeTab(id: PanelId): void {
    const remainingCount = openPanelIds.length - 1
    closeHostedPanel(id, { skipFocusFallback: remainingCount >= 1 })
    if (remainingCount === 0) return
    if (remainingCount === 1) {
      // Drops into the single-panel title-row branch above on the next render; focus its Close
      // button (not a tab ref, which no longer exists once the tablist itself unmounts).
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-panel-close]')?.focus()
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
    <div className="drag-region flex h-10 shrink-0 items-center gap-1 px-2">
      <div className="no-drag-region relative flex min-w-0 flex-1 items-center overflow-hidden">
        <div role="tablist" aria-label="Open panels" className="flex min-w-0 flex-1 items-center gap-1">
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
          const descriptor = getPanelDescriptor(id)
          const position = closePositions[id]
          if (!descriptor || !position) return null
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={id === activePanelId ? 0 : -1}
                  aria-label={`Close ${descriptor.name} panel`}
                  style={{ position: 'absolute', left: position.left, top: position.top }}
                  className={cn(
                    'inline-flex size-6 items-center justify-center rounded text-current hover:bg-foreground/10',
                    FOCUS_VISIBLE
                  )}
                  onClick={() => closeTab(id)}
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
      <div aria-hidden className="no-drag-region shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
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
  return (
    <button
      ref={tabRef}
      role="tab"
      id={`panel-tab-${id}`}
      aria-selected={selected}
      aria-controls={selected ? `panel-content-${id}` : undefined}
      tabIndex={selected ? 0 : -1}
      className={cn(
        // `pr-8` reserves room so the label/count never sits under the overlaid close button.
        // `min-w-0 shrink` (gate remediation, round 1): without it every tab stayed at its content
        // width regardless of available space, overflowing the pane at its 320px default and its
        // 240px minimum; the label's own `truncate` is what actually shrinks, never the icon.
        'relative inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 pr-8 text-sm font-medium',
        FOCUS_VISIBLE,
        selected
          ? 'bg-muted text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{descriptor.name}</span>
      {count && <span className={cn('shrink-0', count.kind === 'running' ? 'text-state-working' : undefined)}>{formatPanelCount(count)}</span>}
    </button>
  )
}
