import { RequiresRepository } from '@/components/RequiresRepository'
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
import { ChecklistPanel } from './checklist/ChecklistPanel'
import { TerminalPanel } from '@/features/terminal/TerminalPanel'
import { PinnedIssuePanel } from './pinned/PinnedIssuePanel'
import { PinnedPullRequestPanel } from './pinned/PinnedPullRequestPanel'
import { resolveActiveTab } from '@/state/right-pane-store'
import { useSessionDocumentTabs } from './useSessionDocumentTabs'
import { DocumentTabView } from '@/features/documents/DocumentTabView'
import { useDiffTabLiveness } from '@/features/documents/useDiffTabLiveness'
import { activeItemKey, buildTabItems, tabDomIds } from './tab-items'
import { isGenuineOpen, openFocusTarget, shellLayout } from './shell-tabs'
import { focusDocumentTab } from './document-tab-focus'
import { focusLocation } from './focus-return-tracker'
import { isFocusStranded, shouldRestoreFocusAfterSwitch } from './pane-focus-targets'

interface RightPaneShellProps {
  sessionId: string | null
}

export function RightPaneShell({ sessionId }: RightPaneShellProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const storePanelId = useRightPaneStore((s) => s.activePanelId)
  const documents = useSessionDocumentTabs(sessionId)
  const documentTabs = documents.tabs
  const activeKey = resolveActiveTab(sessionId, storePanelId, documents)
  const activePanelId = activeKey?.kind === 'panel' ? activeKey.id : null
  const activeKind = activeKey?.kind
  const tabKey = activeItemKey(activeKey)
  const layout = shellLayout(openPanelIds.length + documentTabs.length)
  const subagentSessionId = useSubagentPanelStore((s) => s.sessionId)
  const contentRef = useRef<HTMLDivElement>(null)
  const focusInStripRef = useRef(false)
  const prevSessionRef = useRef(sessionId)
  const paneOpen = useRightPaneStore((s) => s.open)
  useDiffTabLiveness(sessionId)
  // Panel size changes instantly (#678); only content fades and slides in; closing is ignored.
  const panelKey = paneOpen ? tabKey : null
  const launcherRef = useEnterOnSwitch<HTMLDivElement>(paneOpen ? 'launcher' : null, 'panel')
  useEnterOnSwitch(panelKey, 'panel', contentRef)
  const prevTabsRef = useRef<{ sessionId: string | null; keys: ReadonlySet<string> }>({
    sessionId,
    keys: new Set(buildTabItems(openPanelIds, documentTabs).map((item) => item.key))
  })

  useEffect(() => {
    if (paneOpen && sessionId && !subagentSessionId && openPanelIds.includes('subagents')) {
      useSubagentPanelStore.getState().openPanel(sessionId)
    }
  }, [paneOpen, sessionId, subagentSessionId, openPanelIds])

  useEffect(() => {
    const previous = prevTabsRef.current
    const currentKeys = new Set(buildTabItems(openPanelIds, documentTabs).map((item) => item.key))
    prevTabsRef.current = { sessionId, keys: currentKeys }
    const { suppressNextContentFocus } = useRightPaneStore.getState()
    if (suppressNextContentFocus) useRightPaneStore.setState({ suppressNextContentFocus: false })
    // A Session switch swaps the document tabs; that is not a tab opening.
    const target = openFocusTarget(isGenuineOpen(previous, sessionId, tabKey), suppressNextContentFocus, activeKind, layout)
    if (target === 'tab' && sessionId && tabKey && focusDocumentTab(sessionId, tabKey)) return
    if (target !== 'none') contentRef.current?.focus()
  }, [openPanelIds, documentTabs, tabKey, activeKind, layout, sessionId])

  // A Session switch unmounts the strip button that held focus, which drops it to the body; land on the new active tab, or the content when it has no button.
  useEffect(() => {
    if (prevSessionRef.current === sessionId) return
    prevSessionRef.current = sessionId
    const wasInStrip = focusInStripRef.current
    focusInStripRef.current = false
    if (!shouldRestoreFocusAfterSwitch(true, wasInStrip, isFocusStranded(document.activeElement, document.body))) return
    const tab = activeKey ? document.getElementById(tabDomIds(activeKey).tabId) : null
    ;(tab ?? contentRef.current)?.focus()
  }, [sessionId, activeKey])

  if (layout === 'launcher') {
    return (
      <div data-right-pane-shell className="relative flex h-full flex-col overflow-hidden bg-sidebar-right">
        <div ref={launcherRef} className="min-h-0 flex-1 overflow-hidden">
          <PanelLauncher sessionId={sessionId} />
        </div>
        <HandleHitStrip />
      </div>
    )
  }

  const isTabBar = layout === 'tab-bar'
  const ids = activeKey ? tabDomIds(activeKey) : null

  return (
    <div
      id="right-pane-active-panel"
      data-right-pane-shell
      className="relative flex h-full flex-col overflow-hidden bg-sidebar-right"
      onFocus={(event) => {
        focusInStripRef.current = focusLocation(event.target, document.body) === 'tab-strip'
      }}
      onBlur={(event) => {
        // A removed element reports a disconnected target; that is the case the Session-switch restore needs to remember.
        if (event.target.isConnected && !event.currentTarget.contains(event.relatedTarget)) focusInStripRef.current = false
      }}
    >
      <PanelTabBar sessionId={sessionId} />
      <div
        ref={contentRef}
        data-right-pane-content
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        role={isTabBar ? 'tabpanel' : 'region'}
        id={isTabBar ? ids?.panelId : undefined}
        aria-labelledby={isTabBar && ids ? ids.tabId : 'right-pane-panel-title'}
      >
        {activeKey?.kind === 'document' && <DocumentTabView sessionId={activeKey.sessionId} tabId={activeKey.id} />}
        {activePanelId === 'subagents' && <SubagentPanel sessionId={subagentSessionId} />}
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
        {activePanelId === 'file-explorer' && (
          <RequiresRepository sessionId={sessionId}>
            <FileExplorerPanel sessionId={sessionId} />
          </RequiresRepository>
        )}
        {activePanelId === 'git-changes' && (
          <RequiresRepository sessionId={sessionId}>
            <GitChangesPanel sessionId={sessionId} />
          </RequiresRepository>
        )}
        {activePanelId === 'outline' && <OutlinePanel sessionId={sessionId} />}
        {activePanelId === 'session-usage' && <SessionUsagePanel sessionId={sessionId} />}
        {activePanelId === 'checklist' && <ChecklistPanel sessionId={sessionId} />}
        {activePanelId === 'terminal' && <TerminalPanel sessionId={sessionId} />}
        {activePanelId === 'pull-request' && (
          <RequiresRepository sessionId={sessionId}>
            <PinnedPullRequestPanel sessionId={sessionId} />
          </RequiresRepository>
        )}
        {activePanelId === 'issue' && (
          <RequiresRepository sessionId={sessionId}>
            <PinnedIssuePanel sessionId={sessionId} />
          </RequiresRepository>
        )}
      </div>
      <HandleHitStrip />
    </div>
  )
}

function HandleHitStrip() {
  return <div aria-hidden className="no-drag-region pointer-events-none absolute inset-y-0 left-0 w-1.5" />
}
