// The generalised right pane shell (spec 013): renders the header (a single title row, a tab
// bar, or the centred launcher, picked purely from `openPanelIds.length` -- data-model.md
// `OpenPanelsState`) plus the active panel's own content. Mounted as the `right-pane`
// `ResizablePanel`'s content in `App.tsx`; the permanent icon rail is a separate sibling, not
// rendered here.
import { useEffect, useRef } from 'react'
import { useRightPaneStore, useSideChatStore, useSubagentPanelStore } from '@/state'
import { SubagentPanel } from '@/features/subagents/SubagentPanel'
import { PanelLauncher } from './PanelLauncher'
import { PanelTabBar } from './PanelTabBar'
import { WidthPresetControl } from './WidthPresetControl'
import { WindowControlsSpacerRow } from './WindowControlsSpacerRow'
import { FdbKnowledgePanel } from './placeholders/FdbKnowledgePanel'
import { AgentBuilderPanel } from './placeholders/AgentBuilderPanel'
import { SideChatPanel } from './side-chat/SideChatPanel'
import { FileExplorerPanel } from './file-explorer/FileExplorerPanel'
import { GitChangesPanel } from './git-changes/GitChangesPanel'
import type { PanelId } from './panel-registry'

interface RightPaneShellProps {
  /** The focused chat pane's Session -- passed down to the launcher/tab bar for opening a new
   * panel and for a per-Session panel's live count. Most hosted panels read their own binding
   * instead (e.g. `SubagentPanel` reads `subagent-store.ts`'s `sessionId`); `SideChatPanel` is
   * the one exception (spec 014 T006/T007) and reads this prop directly, since a side-chat
   * thread has no independent binding of its own (FR-005: it always follows whichever Session
   * the chat pane currently shows). */
  sessionId: string | null
  /** The pane's non-drag resize alternative (spec 013 FR-025, WCAG 2.5.7) -- `App.tsx`'s own
   * `ResizablePanel` ref, forwarded to `WidthPresetControl` in every state the pane can be open
   * in, including the 0-panel launcher below. */
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
  // standard ARIA tabs behaviour). Gate-fix (round 7, Code7/A11y7/Sec7 HIGH): also skipped when
  // `openPanel` was called with `{ focus: false }` (`suppressNextContentFocus`, read fresh via
  // `getState()` since this effect must not re-run just because that flag changed) -- round 6's
  // own `focus:false` only suppressed `sideChatFocusRequestId` (the side-chat TEXTAREA'S own
  // focus request), so this effect still stole focus into the pane's content wrapper for the
  // common "/btw while !loaded, pane collapsed" case. The flag is always cleared on read, even
  // when this is not a genuine open, so it never leaks into a LATER, unrelated real open.
  useEffect(() => {
    const prevIds = prevOpenPanelIdsRef.current
    const isGenuineOpen = activePanelId !== null && !prevIds.includes(activePanelId)
    prevOpenPanelIdsRef.current = openPanelIds
    const { suppressNextContentFocus } = useRightPaneStore.getState()
    if (suppressNextContentFocus) useRightPaneStore.setState({ suppressNextContentFocus: false })
    if (isGenuineOpen && !suppressNextContentFocus) contentRef.current?.focus()
  }, [openPanelIds, activePanelId])

  if (openPanelIds.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <WindowControlsSpacerRow />
        <WidthPresetControl resize={resize} />
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
        {activePanelId === 'side-chat' && (
          <SideChatPanel
            sessionId={sessionId}
            onSend={async (question) => {
              if (!sessionId) return
              await useSideChatStore.getState().ask(sessionId, question)
            }}
          />
        )}
        {activePanelId === 'file-explorer' && <FileExplorerPanel sessionId={sessionId} />}
        {activePanelId === 'git-changes' && <GitChangesPanel sessionId={sessionId} />}
      </div>
    </div>
  )
}
