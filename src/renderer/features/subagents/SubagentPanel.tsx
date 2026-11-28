// The Agents panel (#490): every Session's agents as one disclosure group each, over the selected agent's live stream.
// `sessionId` is the Session the stream pane is bound to; selecting a row of another Session rebinds the panel to it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EMPTY_TRANSCRIPT, useSubagentPanelStore, useTranscriptStore } from '@/state'
import { totalRunningAgents, useAgentsStore } from '@/state/agents-store'
import { groupToolItems, isToolGroup } from '../chat/groupToolItems'
import { ToolGroupRow } from '../chat/ToolRow'
import { LinkContext, Markdown } from '../chat/Markdown'
import { NoticeRow } from '../chat/NoticeRow'
import { AgentDetailSummary, AgentsGroupSection, AgentsStatusLine } from './SubagentPanelTree'
import {
  buildGroupRows,
  findSelectedSummary,
  panelFocusRows,
  pendingFocusTarget,
  selectedRowKey,
  selectionRoute,
  toggleGroupCollapsed,
  type AgentRow
} from './subagentPanelRows'
import { selectScenarioFromSummaries, selectSubagentItems } from './viewModel'
import { agentKey } from './viewModel/fromTranscript'
import { usePanelFocusRecovery } from './usePanelFocusRecovery'

// Stable singletons: a fresh `?? []` each render would look like a changed snapshot to zustand.
const NO_STREAM: readonly never[] = []
const NO_SUMMARIES: readonly never[] = []

export function SubagentPanel({ sessionId }: { sessionId: string }) {
  const agentGroups = useAgentsStore((s) => s.groups)
  // The detail's outcome text lives on the bound Session's transcript items, not on the summaries Rust sends.
  const subagentItems = useTranscriptStore(useShallow((s) => selectSubagentItems((s.bySession[sessionId] ?? EMPTY_TRANSCRIPT).items)))
  const selectedId = useSubagentPanelStore((s) => s.selectedId)
  const storeSelectedKey = useSubagentPanelStore((s) => s.selectedKey)
  const selectSubagent = useSubagentPanelStore((s) => s.selectSubagent)
  const openPanel = useSubagentPanelStore((s) => s.openPanel)
  // Only the selected agent's stream: a token arriving for another agent must not re-render this panel.
  const selectedStream = useSubagentPanelStore((s) => (s.selectedId ? s.streams[s.selectedId] : undefined)) ?? NO_STREAM
  const pendingFocusSubagentId = useSubagentPanelStore((s) => s.pendingFocusSubagentId)
  const pendingFocusSubagentKey = useSubagentPanelStore((s) => s.pendingFocusSubagentKey)
  const clearPendingFocus = useSubagentPanelStore((s) => s.clearPendingFocus)
  const grouped = useMemo(() => groupToolItems([...selectedStream]), [selectedStream])

  // Nothing is persisted: a group is open until the developer closes it, and every group opens afresh on a remount.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => buildGroupRows(agentGroups), [agentGroups])
  const totalRunning = useMemo(() => totalRunningAgents(agentGroups), [agentGroups])
  const focusRows = useMemo(() => panelFocusRows(groups, collapsed), [groups, collapsed])
  const boundSummaries = agentGroups.find((group) => group.sessionId === sessionId)?.subagents ?? NO_SUMMARIES
  const selection = useMemo(() => ({ selectedId, selectedKey: storeSelectedKey }), [selectedId, storeSelectedKey])
  const selectedKey = useMemo(() => selectedRowKey(groups, sessionId, selection), [groups, sessionId, selection])

  const rowRefs = useRef<Map<string, HTMLElement>>(new Map())
  const treeHostRef = useRef<HTMLDivElement>(null)
  const { trackFocus, releaseFocus } = usePanelFocusRecovery(focusRows, rowRefs, treeHostRef)

  // The same view-model the chat card reads, so the detail shows the one outcome and file list both surfaces share (FR-150).
  const selectedAgent = useMemo(() => {
    const summary = findSelectedSummary(boundSummaries, selection)
    if (!summary) return undefined
    const key = agentKey(summary.toolCallId, summary.specIndex)
    return selectScenarioFromSummaries([...boundSummaries], subagentItems)
      .stages.flatMap((stage) => stage.agents)
      .find((agent) => agent.key === key)
  }, [boundSummaries, selection, subagentItems])

  useEffect(() => {
    if (!pendingFocusSubagentKey && !pendingFocusSubagentId) return
    const target = pendingFocusTarget(groups, sessionId, { pendingFocusKey: pendingFocusSubagentKey, pendingFocusId: pendingFocusSubagentId })
    if (target && collapsed.has(sessionId)) {
      // A closed group has nothing to focus; opening it re-runs this effect with the row mounted.
      setCollapsed((current) => toggleGroupCollapsed(current, sessionId))
      return
    }
    if (target) rowRefs.current.get(target)?.focus()
    clearPendingFocus()
  }, [pendingFocusSubagentId, pendingFocusSubagentKey, clearPendingFocus, groups, collapsed, sessionId])

  const rowRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element) rowRefs.current.set(key, element)
    else rowRefs.current.delete(key)
  }, [])
  const onToggle = useCallback((groupSessionId: string) => setCollapsed((current) => toggleGroupCollapsed(current, groupSessionId)), [])
  // A row selects (its live stream opens); one in another Session rebinds the panel to that Session as it does.
  const onSelect = useCallback(
    (groupSessionId: string, row: AgentRow) => {
      const key = agentKey(row.summary.toolCallId, row.summary.specIndex)
      if (selectionRoute(sessionId, groupSessionId) === 'select') void selectSubagent(row.summary.id, key)
      else openPanel(groupSessionId, { selectSubagentId: row.summary.id, selectSubagentKey: key })
    },
    [sessionId, selectSubagent, openPanel]
  )

  return (
    <LinkContext.Provider value={sessionId}>
      {/* FR-024: a vertical split, groups above stream -- the FileExplorerPanel.tsx tree/preview precedent. */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60%" minSize="20%">
          <div ref={treeHostRef} onFocus={trackFocus} onBlur={releaseFocus} className="h-full overflow-y-auto px-2 py-2">
            <AgentsStatusLine totalRunning={totalRunning} />
            {groups.map((group) => (
              <AgentsGroupSection key={group.key} group={group} collapsed={collapsed.has(group.sessionId)} selectedKey={selectedKey} rowRef={rowRef} onSelect={onSelect} onToggle={onToggle} />
            ))}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize agent list and stream" />
        <ResizablePanel defaultSize="40%" minSize="15%">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-2 px-4 py-2">
              {selectedId === null && <p className="px-1 py-2 text-sm text-muted-foreground">Select an agent to see its live stream.</p>}
              {/* The row shows one line; the whole outcome and every touched file are here. */}
              {selectedAgent && <AgentDetailSummary agent={selectedAgent} />}
              {grouped.map((item) =>
                isToolGroup(item) ? (
                  <ToolGroupRow key={item.id} group={item} summaryWrap />
                ) : item.kind === 'assistant-text' ? (
                  <Markdown key={item.id} id={item.id} text={item.text} streaming={item.streaming} />
                ) : item.kind === 'notice' ? (
                  // A candidate seeded purely from the transcript has no tool-group or assistant text, only this placeholder.
                  <NoticeRow key={item.id} level={item.level} text={item.text} source={item.source} />
                ) : null
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </LinkContext.Provider>
  )
}
