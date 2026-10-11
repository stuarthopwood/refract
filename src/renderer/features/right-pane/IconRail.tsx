// The permanent icon rail (spec 013 FR-001, issue://538): one button per available panel, always
// visible at the window's right edge whether the pane is open or collapsed. Mounted in App.tsx as
// a fixed sibling of the `ResizablePanelGroup`, not inside the pane's own content, so it never
// disappears when the pane collapses.
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRightPaneStore } from '@/state'
import { HOSTED_PANELS } from './panel-registry'
import { toggleHostedPanelFromRail } from './hosted-panel-actions'

// Stuart, 2026-10-10: the rail starts below a spacer matching the window's own
// `titleBarOverlay` height, so its top button never sits under the caption buttons.
const TITLE_BAR_OVERLAY_HEIGHT_PX = 40

interface IconRailProps {
  /** The focused chat pane's Session -- the default target a rail click binds a per-Session
   * panel to when opening it (FR-008's existing ambiguous-click rule, generalised). */
  sessionId: string | null
}

export function IconRail({ sessionId }: IconRailProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)

  return (
    <div className="flex w-10 shrink-0 flex-col items-center border-l border-divider bg-background">
      <div aria-hidden className="w-full shrink-0" style={{ height: TITLE_BAR_OVERLAY_HEIGHT_PX }} />
      <div className="flex flex-col items-center gap-1 py-2">
        {HOSTED_PANELS.map((panel) => {
          const Icon = panel.icon
          const pressed = openPanelIds.includes(panel.id)
          const label = `${pressed ? 'Close' : 'Open'} ${panel.name} panel`
          return (
            <Tooltip key={panel.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-rail-button={panel.id}
                  aria-pressed={pressed}
                  aria-label={label}
                  onClick={() => toggleHostedPanelFromRail(panel.id, sessionId)}
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
