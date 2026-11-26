import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useStageToggleStore, useSubagentPanelStore } from '@/state'
import { groupToolItems, isToolGroup } from '../chat/groupToolItems'
import { ToolGroupRow } from '../chat/ToolRow'
import { LinkContext, Markdown } from '../chat/Markdown'
import { NoticeRow } from '../chat/NoticeRow'
import { overallStatus } from '../chat/subagentChainStatus'
import { AgentDetailSummary, LivePanelHeader, PanelTree } from './SubagentPanelTree'
import {
  buildPanelRows,
  isPanelStageOpen,
  panelKeyAction,
  panelStageToggleId,
  resolveSelectedKey,
  stageOfPendingFocus,
  typeaheadIndex,
  type PanelAgentRow
} from './subagentPanelRows'
import { summarizeSubagentStatuses } from './subagentStatus'
import { selectScenarioFromSummaries } from './viewModel'

// Stable singletons: a fresh `?? {}` or `?? []` each render would look like a changed snapshot to zustand.
const NO_TOGGLES: Record<string, boolean> = {}
const NO_STREAM: readonly never[] = []

export function SubagentPanel({ sessionId }: { sessionId: string }) {
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const selectedId = useSubagentPanelStore((s) => s.selectedId)
  const storeSelectedKey = useSubagentPanelStore((s) => s.selectedKey)
  const selectSubagent = useSubagentPanelStore((s) => s.selectSubagent)
  // Only the selected agent's stream: a token arriving for another agent must not re-render this panel.
  const selectedStream = useSubagentPanelStore((s) => (s.selectedId ? s.streams[s.selectedId] : undefined)) ?? NO_STREAM
  const pendingFocusSubagentId = useSubagentPanelStore((s) => s.pendingFocusSubagentId)
  const pendingFocusSubagentKey = useSubagentPanelStore((s) => s.pendingFocusSubagentKey)
  const clearPendingFocus = useSubagentPanelStore((s) => s.clearPendingFocus)
  const toggles = useStageToggleStore((s) => s.bySession[sessionId] ?? NO_TOGGLES)
  const setManualOpen = useStageToggleStore((s) => s.setManualOpen)
  const grouped = useMemo(() => groupToolItems([...selectedStream]), [selectedStream])

  // The same view-model the chat card reads, so both surfaces show one goal, title, outcome and count (FR-150).
  const scenario = useMemo(() => selectScenarioFromSummaries(subagents), [subagents])
  const allAgents = useMemo(() => scenario.stages.flatMap((stage) => stage.agents), [scenario])
  const selectedKey = useMemo(() => resolveSelectedKey(allAgents, { selectedKey: storeSelectedKey, selectedId }), [allAgents, storeSelectedKey, selectedId])
  const rows = useMemo(() => {
    const pending = { pendingFocusKey: pendingFocusSubagentKey, pendingFocusId: pendingFocusSubagentId }
    return buildPanelRows(scenario.stages, (stage) => isPanelStageOpen(stage, toggles[panelStageToggleId(stage.id)], selectedKey, pending))
  }, [scenario, toggles, selectedKey, pendingFocusSubagentKey, pendingFocusSubagentId])

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const typeaheadRef = useRef<{ buffer: string; timer: number | undefined }>({ buffer: '', timer: undefined })

  const tabbableIndex = useMemo(() => {
    if (rows.length === 0) return -1
    const found = rows.findIndex((row) => row.key === selectedKey)
    return found === -1 ? 0 : found
  }, [rows, selectedKey])

  const status = overallStatus(summarizeSubagentStatuses(allAgents.map((agent) => agent.status)))
  const selectedAgent = useMemo(() => allAgents.find((agent) => agent.key === selectedKey), [allAgents, selectedKey])

  useEffect(() => {
    if (!pendingFocusSubagentKey && !pendingFocusSubagentId) return
    const pending = { pendingFocusKey: pendingFocusSubagentKey, pendingFocusId: pendingFocusSubagentId }
    const stage = stageOfPendingFocus(scenario.stages, pending)
    if (stage) {
      const stageRow = rows.find((row) => row.kind === 'stage' && row.stage.id === stage.id)
      if (stageRow?.kind === 'stage' && !stageRow.open) {
        // A collapsed Stage has no row to focus; opening it re-runs this effect with the row mounted.
        setManualOpen(sessionId, panelStageToggleId(stage.id), true)
        return
      }
      const agentKey = pendingFocusSubagentKey ?? stage.agents.find((agent) => agent.id === pendingFocusSubagentId)?.key
      if (agentKey) rowRefs.current.get(agentKey)?.focus()
    }
    clearPendingFocus()
  }, [pendingFocusSubagentId, pendingFocusSubagentKey, clearPendingFocus, rows, scenario, sessionId, setManualOpen])

  // The handlers read the latest rows through a ref, so their identity never changes and the memoised tree rows are not re-rendered by it.
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const moveToRow = useCallback((index: number): void => {
    const row = rowsRef.current[index]
    if (row) rowRefs.current.get(row.key)?.focus()
  }, [])

  const handleTypeahead = useCallback(
    (char: string, fromIndex: number): void => {
      clearTimeout(typeaheadRef.current.timer)
      typeaheadRef.current.buffer += char.toLowerCase()
      typeaheadRef.current.timer = window.setTimeout(() => {
        typeaheadRef.current.buffer = ''
      }, 500)
      const found = typeaheadIndex(rowsRef.current, fromIndex, typeaheadRef.current.buffer)
      if (found !== -1) moveToRow(found)
    },
    [moveToRow]
  )

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
      // A key pressed on a control inside the row (a "Uses:" link, the chevron) belongs to that control.
      if (event.target !== event.currentTarget) return
      const action = panelKeyAction(rowsRef.current, index, event.key)
      if (action) {
        event.preventDefault()
        if (action.type === 'focus') moveToRow(action.index)
        else setManualOpen(sessionId, panelStageToggleId(action.stageId), action.open)
        return
      }
      if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) handleTypeahead(event.key, index)
    },
    [moveToRow, handleTypeahead, setManualOpen, sessionId]
  )

  const rowRef = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(key, element)
    else rowRefs.current.delete(key)
  }, [])
  // Issue #941 part 2: a Stage row has no single subagent to stream, so only an agent row selects.
  const onFocusRow = useCallback((row: PanelAgentRow) => void selectSubagent(row.agent.id, row.agent.key), [selectSubagent])
  const onToggleStage = useCallback((stageId: string, open: boolean) => setManualOpen(sessionId, panelStageToggleId(stageId), open), [setManualOpen, sessionId])

  return (
    <LinkContext.Provider value={sessionId}>
      {/* FR-024: a vertical split, tree above stream -- the FileExplorerPanel.tsx tree/preview
          precedent (its own tabbed and resizable 60/20 over 40/15 split). */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60%" minSize="20%">
          {rows.length > 0 ? (
            // @container: the shared card pieces size themselves from this pane's width, not the viewport (FR-150 c).
            <div className="@container h-full overflow-y-auto px-4 py-2">
              <LivePanelHeader scenario={scenario} status={status} />
              <PanelTree rows={rows} selectedKey={selectedKey} tabbableIndex={tabbableIndex} sessionId={sessionId} rowRef={rowRef} onKeyDown={handleRowKeyDown} onFocusRow={onFocusRow} onToggleStage={onToggleStage} />
            </div>
          ) : (
            <p className="px-2 py-1 text-sm text-muted-foreground">No agents running.</p>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize agent tree and stream" />
        <ResizablePanel defaultSize="40%" minSize="15%">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-2 px-4 py-2">
              {selectedId === null && <p className="px-1 py-2 text-sm text-muted-foreground">Select a subagent to see its live stream.</p>}
              {/* The tree row clamps the outcome and folds the files behind "+N" (not a tab stop there); the whole of both is here. */}
              {selectedAgent && <AgentDetailSummary agent={selectedAgent} />}
              {grouped.map((item) =>
                isToolGroup(item) ? (
                  <ToolGroupRow key={item.id} group={item} summaryWrap />
                ) : item.kind === 'assistant-text' ? (
                  <Markdown key={item.id} id={item.id} text={item.text} streaming={item.streaming} />
                ) : item.kind === 'notice' ? (
                  // Gate fixes 2 finding 6: a candidate seeded purely from the transcript
                  // (`SessionAgent.reconcileSubagentsOnAttach`) has no tool-group/assistant-text
                  // at all, only this explanatory `notice` placeholder -- mapping it to `null`
                  // left the pane blank with no explanation once selected.
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
