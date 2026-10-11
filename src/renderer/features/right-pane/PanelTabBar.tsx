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
// PR2 round 2: round 1's `min-w-0 shrink` let a tab's own measured box (used to position its close
// button) shrink below content that does not shrink -- the icon, and the close button's own
// reserved space -- so at narrow widths the close button landed ON TOP OF the icon: clicking a
// tab's icon closed it instead of selecting it (WCAG 2.5.8), and at the pane's 320px default with
// three panels every tab's label was clipped to near nothing with no Tooltip to recover the name
// (FR-026). Round 2 redesign (replaces round 1's per-tab shrink/truncate entirely): every tab
// EXCEPT the active one renders as a fixed 28px icon-only square (`w-7 shrink-0`, no close button
// overlay at all, `aria-label` carrying its full name and count, and its own Tooltip -- the FR-026
// icon-only bundle); only the ACTIVE tab shows its icon, a truncating label, a truncating count,
// and the one close button this bar ever renders at a time, with a `min-w-14` (56px) floor sized
// around the icon plus the close button's own reserved space specifically (never the label, which
// may truncate to nothing at that exact floor -- the active state is already marked by more than
// its label, via the underline and surface change, and its close button carries its own Tooltip
// with the full name). This needs no width-measurement or compact/non-compact toggle at all: the
// floor is a fixed minimum regardless of pane width, and the geometry table in tasks.md proves it
// fits at every supported pane width (240/320/520px) with up to three panels open, including one
// showing a live count, with room to spare -- `overflow-x-auto` on the wrapper stays only as a
// safety net for a future fourth panel; it should never actually scroll for this spec's own three.
// Closing an inactive tab from the pointer is therefore select-then-close (click selects it,
// revealing its close button); Delete on a focused inactive tab still closes it directly, since
// `handleTabKeyDown` reads the keystroke from the tab button itself, never from the close overlay.
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

  // Gate remediation (round 2): the active tab is the only one with a close button, so only its
  // own position needs tracking -- not a map over every open tab the way round 1's per-tab
  // overlay needed. A `ResizeObserver` on that one tab re-measures its close button's position
  // whenever the tab's own content changes width (its live count's digit count, for example).
  const [closePosition, setClosePosition] = useState<{ left: number; top: number } | null>(null)

  const recomputeClosePosition = () => {
    const el = activePanelId ? tabRefs.current[activePanelId] : null
    if (!el) {
      setClosePosition(null)
      return
    }
    setClosePosition({
      left: el.offsetLeft + el.offsetWidth - CLOSE_BUTTON_PX - CLOSE_BUTTON_INSET_PX,
      top: el.offsetTop + (el.offsetHeight - CLOSE_BUTTON_PX) / 2
    })
  }

  useLayoutEffect(() => {
    recomputeClosePosition()
    const el = activePanelId ? tabRefs.current[activePanelId] : null
    if (!el) return
    const observer = new ResizeObserver(() => recomputeClosePosition())
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId, openPanelIds])

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
  // out. Gate remediation (Low, round 2): the `remainingCount === 0` case from round 1 was dead
  // code -- this function only ever runs from the tab-bar branch below, which never renders with
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

  const activeDescriptor = activePanelId ? getPanelDescriptor(activePanelId) : undefined

  return (
    <div ref={wrapperRef} className="drag-region flex h-10 shrink-0 items-center gap-1 px-2">
      <div ref={wrapRef} className="no-drag-region relative flex min-w-0 flex-1 items-center overflow-x-auto">
        <div role="tablist" aria-label="Open panels" className="flex min-w-0 items-center gap-1">
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
        {activePanelId && activeDescriptor && closePosition && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                tabIndex={0}
                aria-label={`Close ${activeDescriptor.name} panel`}
                style={{ position: 'absolute', left: closePosition.left, top: closePosition.top }}
                className={cn(
                  'inline-flex size-6 items-center justify-center rounded text-current hover:bg-foreground/10',
                  FOCUS_VISIBLE
                )}
                onClick={() => closeTab(activePanelId)}
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {`Close ${activeDescriptor.name} panel`}
              <Kbd>Delete</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
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
  const countText = count ? formatPanelCount(count) : undefined

  const button = (
    <button
      ref={tabRef}
      role="tab"
      id={`panel-tab-${id}`}
      aria-selected={selected}
      aria-controls={selected ? `panel-content-${id}` : undefined}
      aria-label={!selected ? `${descriptor.name}${countText ? ` ${countText}` : ''}` : undefined}
      tabIndex={selected ? 0 : -1}
      className={cn(
        'relative inline-flex h-7 items-center rounded-md text-sm font-medium',
        FOCUS_VISIBLE,
        // Round 2 redesign: a selected tab gets a floor sized around its icon plus the overlaid
        // close button's own reserved space specifically (`pr-8`) -- never the label, which may
        // truncate to nothing at that exact floor (geometry table, tasks.md). An unselected tab is
        // a fixed 28px icon-only square (`w-7`): with no close button ever drawn on it, it has
        // nothing left to reserve space for, and `shrink-0` keeps every inactive tab's width
        // identical regardless of how many others are open.
        selected ? 'min-w-14 shrink gap-1.5 px-2.5 pr-8' : 'w-7 shrink-0 justify-center',
        selected
          ? 'bg-muted text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {selected && (
        <>
          <span className="min-w-0 truncate">{descriptor.name}</span>
          {countText && (
            <span className={cn('min-w-0 shrink truncate', count?.kind === 'running' ? 'text-state-working' : undefined)}>
              {countText}
            </span>
          )}
        </>
      )}
    </button>
  )

  // Round 2: an unselected tab is icon-only -- the FR-026 bundle (a Tooltip whose text equals the
  // accessible name) applies to it the same way it already does to the icon rail's own buttons.
  // The selected tab's own close button carries its own, separate Tooltip with the full name; the
  // tab itself is not wrapped here, since it always shows at least its icon plus whatever of its
  // label/count fits, never pure icon-only the way an unselected tab always is.
  if (selected) return button
  const label = `${descriptor.name}${countText ? ` ${countText}` : ''}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
