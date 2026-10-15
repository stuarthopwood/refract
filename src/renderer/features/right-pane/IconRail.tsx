// The permanent icon rail (spec 013 FR-001, issue://538): one button per available panel, always
// visible at the window's right edge whether the pane is open or collapsed. Mounted in App.tsx as
// a fixed sibling of the `ResizablePanelGroup`, not inside the pane's own content, so it never
// disappears when the pane collapses.
//
// PR2: roving-tabindex arrow-key navigation (the standard ARIA toolbar pattern,
// `aria-orientation="vertical"` so ArrowUp/ArrowDown move focus, Home/End jump to the first/last
// button) -- not built in PR1, when there was exactly one button and nothing to rove between.
// Only the "active" button (the one last focused, defaulting to the first) carries `tabIndex={0}`;
// every other button is `-1` and reachable only via the arrow keys, so Tab moves past the whole
// toolbar in one stop, matching every other composite widget in this codebase (`PanelTabBar.tsx`'s
// own tabs).
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRightPaneStore } from '@/state'
import { TITLE_BAR_OVERLAY_HEIGHT } from '../../../shared/layout'
import { HOSTED_PANELS, type PanelId } from './panel-registry'
import { toggleHostedPanelFromRail } from './hosted-panel-actions'

interface IconRailProps {
  /** The focused chat pane's Session -- the default target a rail click binds a per-Session
   * panel to when opening it (FR-008's existing ambiguous-click rule, generalised). */
  sessionId: string | null
}

export function IconRail({ sessionId }: IconRailProps) {
  const rightPaneOpen = useRightPaneStore((s) => s.open)
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const [rovingId, setRovingId] = useState<PanelId>(HOSTED_PANELS[0]?.id ?? 'subagents')
  const buttonRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})

  function focusButton(id: PanelId): void {
    setRovingId(id)
    buttonRefs.current[id]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: PanelId): void {
    const index = HOSTED_PANELS.findIndex((panel) => panel.id === id)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = HOSTED_PANELS[(index + delta + HOSTED_PANELS.length) % HOSTED_PANELS.length]
      if (next) focusButton(next.id)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? HOSTED_PANELS[0] : HOSTED_PANELS[HOSTED_PANELS.length - 1]
      if (next) focusButton(next.id)
    }
  }

  return (
    <div className="flex w-10 shrink-0 flex-col items-center border-l border-divider bg-background">
      {/* Stuart, 2026-10-10: the rail starts below a spacer matching the window's own
          `titleBarOverlay` height, so its top button never sits under the caption buttons. */}
      <div aria-hidden className="w-full shrink-0" style={{ height: TITLE_BAR_OVERLAY_HEIGHT }} />
      <div role="toolbar" aria-label="Panels" aria-orientation="vertical" className="flex flex-col items-center gap-1 py-2">
        {HOSTED_PANELS.map((panel) => {
          const Icon = panel.icon
          // Gate remediation (Medium): the pane's own open/collapsed state, not just whether this
          // panel is among `openPanelIds` -- a collapsed pane with panels bound still shows every
          // rail button unpressed, since nothing is actually visible right now (FR-023).
          const pressed = rightPaneOpen && openPanelIds.includes(panel.id)
          // Gate remediation (Medium): a toggle button's accessible name must not change with its
          // own pressed state (the repeated anti-pattern this codebase already fixed once in
          // ChatPane.tsx) -- `aria-pressed` alone carries the state.
          const label = `${panel.name} panel`
          return (
            <Tooltip key={panel.id}>
              <TooltipTrigger asChild>
                <Button
                  ref={(el) => {
                    buttonRefs.current[panel.id] = el
                  }}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-rail-button={panel.id}
                  aria-pressed={pressed}
                  aria-label={label}
                  tabIndex={panel.id === rovingId ? 0 : -1}
                  className="aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:border-foreground"
                  onClick={(event) => toggleHostedPanelFromRail(panel.id, sessionId, event.currentTarget)}
                  onFocus={() => setRovingId(panel.id)}
                  onKeyDown={(event) => handleKeyDown(event, panel.id)}
                >
                  <Icon aria-hidden className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
