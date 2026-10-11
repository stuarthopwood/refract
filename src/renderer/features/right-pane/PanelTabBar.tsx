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
// tablist and the overlay are children of the same `relative`, horizontally-scrollable wrapper, so
// a close button scrolls together with its tab with no extra scroll listener needed (an absolutely
// positioned descendant of a scrollable box still scrolls with that box's content). A
// `ResizeObserver` watches every tab button (a tab's own width changes when its live count's digit
// count changes, shifting its own close button and every later tab's) and recomputes every
// position on any of their resizes, and on `openPanelIds` changes (a tab closing or opening shifts
// everyone after it). Each close button's own `tabIndex` stays synced to the roving-tabindex state
// (0 only when its tab is the active one, -1 otherwise) exactly as before, so it still never joins
// the arrow-key cycle and Tab still only ever adds one extra stop for the whole bar.
//
// Known, accepted trade-off: grouping every tab before every close button in document order changes
// a screen reader's browse-mode reading order ("tab 1, tab 2, ... close 1, close 2" instead of the
// previous "tab 1, close 1, tab 2, close 2"); Tab-key interaction order is unaffected, since
// `tabIndex=-1` elements are never a Tab stop regardless of DOM position. Verified against axe's
// static rule and by code reading only -- a real screen reader pass (NVDA/JAWS/VoiceOver) was not
// performed in this environment; recorded as an open live-check item (issue #650), not claimed.
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRightPaneStore } from '@/state'
import { formatPanelCount, getPanelDescriptor, usePanelCount, type PanelId } from './panel-registry'
import { closeHostedPanel } from './hosted-panel-actions'

const WINDOW_CONTROLS_SPACER_STYLE = { width: 'calc(100vw - env(titlebar-area-width, 100vw))' }
const FOCUS_VISIBLE = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
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

  function closeTab(id: PanelId): void {
    const index = openPanelIds.indexOf(id)
    const remaining = openPanelIds.filter((openId) => openId !== id)
    closeHostedPanel(id)
    const nextId = remaining[Math.min(index, remaining.length - 1)]
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
      <div className="no-drag-region relative flex min-w-0 flex-1 items-center overflow-x-auto">
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
                    'inline-flex size-6 items-center justify-center rounded hover:bg-muted',
                    FOCUS_VISIBLE
                  )}
                  onClick={() => closeTab(id)}
                >
                  <XIcon aria-hidden className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{`Close ${descriptor.name} panel`}</TooltipContent>
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
        'relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 pr-8 text-sm font-medium',
        FOCUS_VISIBLE,
        selected
          ? 'bg-muted text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{descriptor.name}</span>
      {count && <span className={count.kind === 'running' ? 'text-state-working' : undefined}>{formatPanelCount(count)}</span>}
    </button>
  )
}
