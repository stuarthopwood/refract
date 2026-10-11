// The generalised right pane shell (spec 013): renders the header (a single title row, a tab
// bar, or the centred launcher, picked purely from `openPanelIds.length` -- data-model.md
// `OpenPanelsState`) plus the active panel's own content. Mounted as the `right-pane`
// `ResizablePanel`'s content in `App.tsx`; the permanent icon rail is a separate sibling, not
// rendered here.
import { useEffect, useRef } from 'react'
import { useRightPaneStore, useSubagentPanelStore } from '@/state'
import { SubagentPanel } from '@/features/subagents/SubagentPanel'
import { PanelLauncher } from './PanelLauncher'
import { PanelTabBar } from './PanelTabBar'
import { WidthPresetControl } from './WidthPresetControl'
import { WindowControlsSpacerRow } from './WindowControlsSpacerRow'
import { FdbKnowledgePanel } from './placeholders/FdbKnowledgePanel'
import { AgentBuilderPanel } from './placeholders/AgentBuilderPanel'
import type { PanelId } from './panel-registry'

interface RightPaneShellProps {
  /** The focused chat pane's Session -- passed down to the launcher/tab bar for opening a new
   * panel and for a per-Session panel's live count; never used to render a hosted panel's own
   * content (each panel reads its own binding, e.g. `SubagentPanel` reads `subagent-store.ts`'s
   * `sessionId`). */
  sessionId: string | null
  /** The pane's non-drag resize alternative (spec 013 FR-025, WCAG 2.5.7, tasks.md T029) --
   * `App.tsx`'s own `ResizablePanel` ref. Rendered in every state the pane can be open in,
   * including the 0-panel launcher below (gate remediation, round 1: US6/FR-025/SC-008 say "the
   * pane is open", never "a panel is open" -- the launcher reached by closing the last tab or by
   * dragging the pane open is a pane-open state too, and it had a drag handle with no non-drag
   * alternative until this fix). */
  resize(widthPx: number): void
}

export function RightPaneShell({ sessionId, resize }: RightPaneShellProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const subagentSessionId = useSubagentPanelStore((s) => s.sessionId)
  const contentRef = useRef<HTMLDivElement>(null)
  const prevOpenPanelIdsRef = useRef<PanelId[]>([])

  // Focus moves into the newly opened panel's own content -- but only for a genuine open (this
  // panel was not already one of the open tabs a moment ago), never for switching between two
  // already-open tabs (arrow keys or a direct tab click both keep focus on the tab bar, the
  // standard ARIA tabs behaviour).
  useEffect(() => {
    const prevIds = prevOpenPanelIdsRef.current
    if (activePanelId && !prevIds.includes(activePanelId)) contentRef.current?.focus()
    prevOpenPanelIdsRef.current = openPanelIds
  }, [openPanelIds, activePanelId])

  if (openPanelIds.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 flex-col">
          <WindowControlsSpacerRow />
          <WidthPresetControl resize={resize} />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelLauncher sessionId={sessionId} />
        </div>
      </div>
    )
  }

  const isTabBar = openPanelIds.length >= 2

  return (
    <div id="right-pane-active-panel" className="flex h-full flex-col overflow-hidden">
      <PanelTabBar sessionId={sessionId} resize={resize} />
      <div
        ref={contentRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        role={isTabBar ? 'tabpanel' : 'region'}
        id={isTabBar && activePanelId ? `panel-content-${activePanelId}` : undefined}
        aria-labelledby={isTabBar && activePanelId ? `panel-tab-${activePanelId}` : 'right-pane-panel-title'}
      >
        {activePanelId === 'subagents' &&
          (subagentSessionId ? (
            <SubagentPanel sessionId={subagentSessionId} />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Open a Session to see its subagents.</p>
          ))}
        {activePanelId === 'fdb-knowledge' && <FdbKnowledgePanel />}
        {activePanelId === 'agent-builder' && <AgentBuilderPanel />}
      </div>
    </div>
  )
}
