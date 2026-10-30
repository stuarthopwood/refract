// The permanent icon rail: one button per panel, a fixed sibling of the `ResizablePanelGroup` so it stays visible when the pane collapses.
// Roving tabindex (vertical toolbar): only the active button has `tabIndex={0}`, so Tab passes the toolbar in one stop.
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { CountBadge } from '@/components/ui/count-badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRightPaneStore } from '@/state'
import { RAIL_WIDTH_PX, TITLE_BAR_OVERLAY_HEIGHT } from '../../../shared/layout'
import { REORDER_MARKER_CLASS, useReorderable, type ReorderItemProps } from '@/components/reorder/use-reorderable'
import { ReorderAnnouncer } from '@/components/reorder/ReorderAnnouncer'
import { railCountLabel, usePanelCount, type HostedPanelDescriptor, type PanelId } from './panel-registry'
import { savePanelOrder, useOrderedPanels } from './panel-order'
import { toggleHostedPanelFromRail } from './hosted-panel-actions'
import { toggleRightPane } from './toggle-right-pane'

interface IconRailProps {
  /** The focused chat pane's Session: the default target a rail click binds a per-Session panel to. */
  sessionId: string | null
}

export function IconRail({ sessionId }: IconRailProps) {
  const rightPaneOpen = useRightPaneStore((s) => s.open)
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const panels = useOrderedPanels()
  const [rovingId, setRovingId] = useState<PanelId>(panels[0]?.id ?? 'subagents')
  const { containerRef, getItemProps, announcement } = useReorderable({
    ids: panels.map((panel) => panel.id),
    labelFor: (id) => panels.find((panel) => panel.id === id)?.name ?? id,
    onReorder: savePanelOrder
  })
  const buttonRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})

  function focusButton(id: PanelId): void {
    setRovingId(id)
    buttonRefs.current[id]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: PanelId): void {
    // Alt+Shift+Arrow is the reorder chord (handled first, by the reorder hook), not focus movement.
    if (event.altKey && event.shiftKey) return
    const index = panels.findIndex((panel) => panel.id === id)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = panels[(index + delta + panels.length) % panels.length]
      if (next) focusButton(next.id)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? panels[0] : panels[panels.length - 1]
      if (next) focusButton(next.id)
    }
  }

  return (
    <div
      className="flex shrink-0 flex-col items-center border-l border-divider bg-sidebar-right"
      style={{ width: RAIL_WIDTH_PX }}
    >
      {/* Spacer matching the `titleBarOverlay` height so the top button never sits under the caption buttons. */}
      <div aria-hidden className="titlebar-surface w-full shrink-0" style={{ height: TITLE_BAR_OVERLAY_HEIGHT }} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xl"
            data-rail-toggle
            aria-label="Right pane"
            aria-expanded={rightPaneOpen}
            aria-keyshortcuts="Control+Shift+B"
            className="mt-2"
            onClick={() => toggleRightPane()}
          >
            {rightPaneOpen ? <PanelRightCloseIcon aria-hidden /> : <PanelRightOpenIcon aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          Right pane <Kbd>Ctrl+Shift+B</Kbd>
        </TooltipContent>
      </Tooltip>
      <div
        ref={(el) => {
          containerRef.current = el
        }}
        role="toolbar"
        aria-label="Panels"
        aria-orientation="vertical"
        aria-keyshortcuts="Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
        className="flex flex-col items-center gap-1 py-2"
      >
        {panels.map((panel) => (
          <RailButton
            key={panel.id}
            panel={panel}
            sessionId={sessionId}
            reorderProps={getItemProps(panel.id)}
            pressed={rightPaneOpen && openPanelIds.includes(panel.id)}
            tabIndex={panel.id === rovingId ? 0 : -1}
            buttonRef={(el) => {
              buttonRefs.current[panel.id] = el
            }}
            onFocus={() => setRovingId(panel.id)}
            onKeyDown={(event) => handleKeyDown(event, panel.id)}
          />
        ))}
        <ReorderAnnouncer text={announcement.text} serial={announcement.serial} />
      </div>
    </div>
  )
}

interface RailButtonProps {
  panel: HostedPanelDescriptor
  sessionId: string | null
  reorderProps: ReorderItemProps
  pressed: boolean
  tabIndex: number
  buttonRef: (el: HTMLButtonElement | null) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function RailButton({ panel, sessionId, reorderProps, pressed, tabIndex, buttonRef, onFocus, onKeyDown }: RailButtonProps) {
  const Icon = panel.icon
  const count = railCountLabel(usePanelCount(panel.id, sessionId))
  // The accessible name must not change with pressed state (`aria-pressed` carries it); the count is
  // in the name so it is announced while the pane is collapsed.
  const label = `${panel.name} panel${count ? `, ${count.phrase}` : ''}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon-xl"
          data-rail-button={panel.id}
          aria-pressed={pressed}
          aria-label={label}
          tabIndex={tabIndex}
          className={cn(
            'relative aria-pressed:bg-muted aria-pressed:text-accent-text forced-colors:aria-pressed:border-2 forced-colors:aria-pressed:border-[Highlight] data-[reorder-dragging]:opacity-50',
            REORDER_MARKER_CLASS
          )}
          onClick={(event) => toggleHostedPanelFromRail(panel.id, sessionId, event.currentTarget)}
          onFocus={onFocus}
          {...reorderProps}
          onKeyDown={(event) => {
            reorderProps.onKeyDown(event)
            if (!event.defaultPrevented) onKeyDown(event)
          }}
        >
          <Icon aria-hidden />
          {pressed && <ActiveIndicatorBar />}
          {count && <CountBadge value={count.value} tone={panel.id === 'subagents' ? 'accent' : 'neutral'} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}
