import { useEffect, useRef } from 'react'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { useRightPaneStore, useSideChatStore, useSubagentPanelStore } from '@/state'
import { SubagentPanel } from '@/features/subagents/SubagentPanel'
import { PanelLauncher } from './PanelLauncher'
import { PanelTabBar } from './PanelTabBar'
import { FdbKnowledgePanel } from './placeholders/FdbKnowledgePanel'
import { AgentBuilderPanel } from './placeholders/AgentBuilderPanel'
import { SideChatPanel } from './side-chat/SideChatPanel'
import { FileExplorerPanel } from './file-explorer/FileExplorerPanel'
import { GitChangesPanel } from './git-changes/GitChangesPanel'
import { OutlinePanel } from './outline/OutlinePanel'
import { SessionUsagePanel } from '@/features/usage/SessionUsagePanel'
import { PinnedIssuePanel } from './pinned/PinnedIssuePanel'
import { PinnedPullRequestPanel } from './pinned/PinnedPullRequestPanel'
import type { PanelId } from './panel-registry'

interface RightPaneShellProps {
  sessionId: string | null
}

export function RightPaneShell({ sessionId }: RightPaneShellProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const subagentSessionId = useSubagentPanelStore((s) => s.sessionId)
  const contentRef = useRef<HTMLDivElement>(null)
  const paneOpen = useRightPaneStore((s) => s.open)
  // Panel size changes instantly (#678); only content fades and slides in; closing is ignored.
  const panelKey = paneOpen ? activePanelId : null
  const launcherRef = useEnterOnSwitch<HTMLDivElement>(paneOpen ? 'launcher' : null, 'panel')
  useEnterOnSwitch(panelKey, 'panel', contentRef)
  const prevOpenPanelIdsRef = useRef<PanelId[]>(useRightPaneStore.getState().openPanelIds)

  useEffect(() => {
    if (paneOpen && sessionId && !subagentSessionId && openPanelIds.includes('subagents')) {
      useSubagentPanelStore.getState().openPanel(sessionId)
    }
  }, [paneOpen, sessionId, subagentSessionId, openPanelIds])

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
      <div data-right-pane-shell className="relative flex h-full flex-col overflow-hidden bg-sidebar-right">
        <div ref={launcherRef} className="min-h-0 flex-1 overflow-hidden">
          <PanelLauncher sessionId={sessionId} />
        </div>
        <HandleHitStrip />
      </div>
    )
  }

  const isTabBar = openPanelIds.length >= 2

  return (
    <div id="right-pane-active-panel" data-right-pane-shell className="relative flex h-full flex-col overflow-hidden bg-sidebar-right">
      <PanelTabBar sessionId={sessionId} />
      <div
        ref={contentRef}
        data-right-pane-content
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
        {activePanelId === 'outline' && <OutlinePanel sessionId={sessionId} />}
        {activePanelId === 'session-usage' && <SessionUsagePanel sessionId={sessionId} />}
        {activePanelId === 'pull-request' && <PinnedPullRequestPanel />}
        {activePanelId === 'issue' && <PinnedIssuePanel />}
      </div>
      <HandleHitStrip />
    </div>
  )
}

function HandleHitStrip() {
  return <div aria-hidden className="no-drag-region pointer-events-none absolute inset-y-0 left-0 w-1.5" />
}
