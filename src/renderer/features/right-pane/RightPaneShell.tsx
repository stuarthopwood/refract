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
import { PinnedIssuePanel } from './pinned/PinnedIssuePanel'
import { PinnedPullRequestPanel } from './pinned/PinnedPullRequestPanel'
import { resolveActiveTab } from '@/state/right-pane-store'
import { useDocumentTabsStore, type DocumentTab } from '@/state/document-tabs-store'
import { DocumentTabView } from '@/features/documents/DocumentTabView'
import { useDiffTabLiveness } from '@/features/documents/useDiffTabLiveness'
import { activeItemKey, buildTabItems, tabDomIds } from './tab-items'
import { isGenuineOpen, openFocusTarget, shellLayout } from './shell-tabs'
import { focusDocumentTab } from './document-tab-focus'

const NO_TABS: DocumentTab[] = []

interface RightPaneShellProps {
  sessionId: string | null
}

export function RightPaneShell({ sessionId }: RightPaneShellProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const storePanelId = useRightPaneStore((s) => s.activePanelId)
  const documents = useDocumentTabsStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const documentTabs = documents?.tabs ?? NO_TABS
  const activeKey = resolveActiveTab(sessionId, storePanelId, documents)
  const activePanelId = activeKey?.kind === 'panel' ? activeKey.id : null
  const activeKind = activeKey?.kind
  const tabKey = activeItemKey(activeKey)
  const layout = shellLayout(openPanelIds.length + documentTabs.length)
  const subagentSessionId = useSubagentPanelStore((s) => s.sessionId)
  const contentRef = useRef<HTMLDivElement>(null)
  const paneOpen = useRightPaneStore((s) => s.open)
  useDiffTabLiveness(sessionId)
  // Panel size changes instantly (#678); only content fades and slides in; closing is ignored.
  const panelKey = paneOpen ? tabKey : null
  const launcherRef = useEnterOnSwitch<HTMLDivElement>(paneOpen ? 'launcher' : null, 'panel')
  useEnterOnSwitch(panelKey, 'panel', contentRef)
  const prevTabsRef = useRef<{ sessionId: string | null; keys: ReadonlySet<string> }>({
    sessionId,
    keys: new Set(buildTabItems(useRightPaneStore.getState().openPanelIds, documentTabs).map((item) => item.key))
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
    <div id="right-pane-active-panel" data-right-pane-shell className="relative flex h-full flex-col overflow-hidden bg-sidebar-right">
      <PanelTabBar sessionId={sessionId} />
      <div
        ref={contentRef}
        data-right-pane-content
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        role={isTabBar ? 'tabpanel' : 'region'}
        id={isTabBar ? ids?.panelId : undefined}
        aria-labelledby={isTabBar && ids ? ids.tabId : 'right-pane-panel-title'}
      >
        {activeKey?.kind === 'document' && <DocumentTabView sessionId={activeKey.sessionId} tabId={activeKey.id} />}
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
