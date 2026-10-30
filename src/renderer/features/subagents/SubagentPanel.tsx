import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSubagentPanelStore } from '@/state'
import type { SubagentSummary } from '../../../shared/model'
import { groupToolItems, isToolGroup } from '../chat/groupToolItems'
import { ToolGroupRow } from '../chat/ToolRow'
import { formatElapsed } from '../chat/formatElapsed'
import { LinkContext, Markdown } from '../chat/Markdown'
import { NoticeRow } from '../chat/NoticeRow'
import { stageRollupText } from '../chat/stageMeta'
import { overallStatus } from '../chat/subagentChainStatus'
import { groupSubagentsIntoPanelStages } from './groupSubagentPanelStages'
import {
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph,
  SubagentStatusIcon,
  summarizeSubagentStatuses
} from './subagentStatus'

interface SubagentTreeNode {
  id: string
  key: string
  nameOrTask: string
  status: SubagentSummary['status']
  durationMs?: number
  /** Issue #712: a detached background job, shown as a muted "Background" word on its row. */
  background?: boolean
  children: SubagentTreeNode[]
  isStage: boolean
  rollupText?: string
  usesText?: string
  ariaLabel?: string
}

export function buildSubagentTree(subagents: SubagentSummary[]): SubagentTreeNode[] {
  return groupSubagentsIntoPanelStages(subagents).map((stage) => {
    if (stage.items.length === 1) {
      const item = stage.items[0]!
      return {
        id: item.id,
        key: `${item.toolCallId}:${item.specIndex}`,
        nameOrTask: item.nameOrTask,
        status: item.status,
        durationMs: item.durationMs,
        background: item.background,
        children: [],
        isStage: false
      }
    }
    const counts = summarizeSubagentStatuses(stage.items.map((item) => item.status))
    const aggregateStatus = overallStatus(counts)
    const label = stage.label ?? `${stage.items.length} agents`
    const rollupText = stageRollupText(counts, stage.items.length, aggregateStatus === 'running')
    const usesText = stage.dependencies.length > 0 ? `Uses: ${stage.dependencies.map((d) => d.agentId).join(', ')}` : undefined
    return {
      id: '',
      key: stage.key,
      nameOrTask: label,
      status: aggregateStatus,
      children: stage.items.map((item) => ({
        id: item.id,
        key: `${item.toolCallId}:${item.specIndex}`,
        nameOrTask: item.nameOrTask,
        status: item.status,
        durationMs: item.durationMs,
        background: item.background,
        children: [],
        isStage: false
      })),
      isStage: true,
      rollupText,
      usesText,
      ariaLabel: `${label}, ${rollupText}${aggregateStatus !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[aggregateStatus]}` : ''}${usesText ? `, ${usesText}` : ''}`
    }
  })
}

function stageRollupDisplayText(node: SubagentTreeNode): string {
  return `${node.rollupText ?? ''}${node.status === 'running' ? ` \u00b7 ${SUBAGENT_STATUS_LABEL.running}` : ''}`
}

interface SubagentTreeRow {
  node: SubagentTreeNode
  depth: number
  posinset: number
  setsize: number
}

function flattenSubagentTree(nodes: SubagentTreeNode[], depth = 0): SubagentTreeRow[] {
  const rows: SubagentTreeRow[] = []
  nodes.forEach((node, index) => {
    rows.push({ node, depth, posinset: index + 1, setsize: nodes.length })
    rows.push(...flattenSubagentTree(node.children, depth + 1))
  })
  return rows
}

export function SubagentPanel({ sessionId }: { sessionId: string }) {
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const selectedId = useSubagentPanelStore((s) => s.selectedId)
  const storeSelectedKey = useSubagentPanelStore((s) => s.selectedKey)
  const selectSubagent = useSubagentPanelStore((s) => s.selectSubagent)
  const streams = useSubagentPanelStore((s) => s.streams)
  const selectedStream = selectedId ? (streams[selectedId] ?? []) : []
  const grouped = groupToolItems(selectedStream)

  const rows = useMemo(() => flattenSubagentTree(buildSubagentTree(subagents)), [subagents])
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const typeaheadRef = useRef<{ buffer: string; timer: number | undefined }>({
    buffer: '',
    timer: undefined
  })
  const effectiveSelectedKey = useMemo(() => {
    if (storeSelectedKey && rows.some((row) => row.node.key === storeSelectedKey)) return storeSelectedKey
    if (!selectedId) return null
    return rows.find((row) => row.node.id === selectedId)?.node.key ?? null
  }, [storeSelectedKey, selectedId, rows])

  const tabbableIndex = useMemo(() => {
    if (rows.length === 0) return -1
    const found = rows.findIndex((row) => row.node.key === effectiveSelectedKey)
    return found === -1 ? 0 : found
  }, [rows, effectiveSelectedKey])

  const pendingFocusSubagentId = useSubagentPanelStore((s) => s.pendingFocusSubagentId)
  const pendingFocusSubagentKey = useSubagentPanelStore((s) => s.pendingFocusSubagentKey)
  const clearPendingFocus = useSubagentPanelStore((s) => s.clearPendingFocus)
  useEffect(() => {
    if (pendingFocusSubagentKey) {
      rowRefs.current.get(pendingFocusSubagentKey)?.focus()
      clearPendingFocus()
      return
    }
    if (pendingFocusSubagentId) {
      const row = rows.find((r) => r.node.id === pendingFocusSubagentId)
      if (row) rowRefs.current.get(row.node.key)?.focus()
      clearPendingFocus()
    }
  }, [pendingFocusSubagentId, pendingFocusSubagentKey, clearPendingFocus, rows])

  function moveToRow(index: number): void {
    const row = rows[index]
    if (!row) return
    rowRefs.current.get(row.node.key)?.focus()
  }

  function handleTypeahead(char: string, fromIndex: number): void {
    clearTimeout(typeaheadRef.current.timer)
    typeaheadRef.current.buffer += char.toLowerCase()
    const buffer = typeaheadRef.current.buffer
    typeaheadRef.current.timer = setTimeout(() => {
      typeaheadRef.current.buffer = ''
    }, 500)
    const total = rows.length
    for (let offset = 1; offset <= total; offset += 1) {
      const candidateIndex = (fromIndex + offset) % total
      const candidate = rows[candidateIndex]
      if (candidate && candidate.node.nameOrTask.toLowerCase().startsWith(buffer)) {
        moveToRow(candidateIndex)
        return
      }
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number): void {
    const row = rows[index]
    if (!row) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (index + 1 < rows.length) moveToRow(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (index > 0) moveToRow(index - 1)
        break
      case 'Home':
        event.preventDefault()
        moveToRow(0)
        break
      case 'End':
        event.preventDefault()
        moveToRow(rows.length - 1)
        break
      case 'ArrowRight': {
        event.preventDefault()
        const next = rows[index + 1]
        if (next && next.depth === row.depth + 1) moveToRow(index + 1)
        break
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (row.depth === 0) break
        for (let i = index - 1; i >= 0; i -= 1) {
          if (rows[i]!.depth < row.depth) {
            moveToRow(i)
            break
          }
        }
        break
      }
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handleTypeahead(event.key, index)
        }
    }
  }

  return (
    <LinkContext.Provider value={sessionId}>
      {/* FR-024: a vertical split, tree above stream -- the FileExplorerPanel.tsx tree/preview
          precedent (its own tabbed and resizable 60/20 over 40/15 split). */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60%" minSize="20%">
          {rows.length > 0 ? (
            <div role="tree" aria-label="Subagents" className="flex h-full flex-col gap-1 overflow-y-auto px-4 py-2">
              {rows.map((row, index) => (
                <div
                  key={row.node.key}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.node.key, el)
                    else rowRefs.current.delete(row.node.key)
                  }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-setsize={row.setsize}
                  aria-posinset={row.posinset}
                  aria-selected={row.node.isStage ? undefined : row.node.key === effectiveSelectedKey}
                  aria-expanded={row.node.isStage ? true : undefined}
                  aria-label={row.node.isStage ? row.node.ariaLabel : undefined}
                  tabIndex={index === tabbableIndex ? 0 : -1}
                  style={{ paddingLeft: `${8 + Math.min(row.depth, 2) * 16}px` }}
                  // Issue #941 part 2: a Stage header row has no single subagent id to show a
                  // stream for -- never calls `selectSubagent`, so focusing it neither selects
                  // nor fetches anything (it stays a pure roving-tabindex stop).
                  onFocus={() => {
                    if (!row.node.isStage) void selectSubagent(row.node.id, row.node.key)
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, index)}
                  className={cn(
                    // Issue #941 part 2: `flex-col` unconditionally (was `items-center` on this
                    // same element) -- an ordinary row's single inner `flex items-center` span
                    // below renders identically either way; a Stage header row with a real
                    // "Uses:" line gets a genuine second line underneath it.
                    'relative flex w-full flex-col gap-1 rounded-md py-1 pr-2 text-left text-sm',
                    !row.node.isStage && 'hover:bg-row-hover-bg',
                    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent aria-selected:text-accent-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
                  )}
                >
                  {/* Issue #1122: the shared `ActiveIndicatorBar` (square, flush full-height,
                      2px) replaces this row's own hand-copied rounded/inset span -- decision 13
                      (issue #563)'s bar-only treatment is superseded by the fill above. */}
                  {row.node.key === effectiveSelectedKey && <ActiveIndicatorBar />}
                  <span className="flex w-full items-center gap-2">
                    {/* Gate round 3 fix (issue #941 part 2, item 1, MEDIUM): a Stage header's own
                        icon slot is now a FIXED `w-4` box with NO visible status word
                        (`SubagentStatusGlyph`, matching `CollapsedLine`'s own `size-4` icon slot,
                        #565 decision 7) -- the previous `SubagentStatusIcon` here showed the
                        status word inline for a running/failed/etc. row, so the slot's own width
                        (and therefore where the label column starts) varied by status-text
                        length, throwing the Uses line's own fixed `pl-6` indent below out of
                        alignment. A member/solo row keeps `SubagentStatusIcon` (visible word)
                        unchanged -- nothing renders beneath it needing a stable column to align
                        against. */}
                    <span className={row.node.isStage ? 'flex h-5 w-4 shrink-0 items-center justify-center' : 'flex shrink-0 items-center gap-2'}>
                      {row.node.isStage ? <SubagentStatusGlyph status={row.node.status} /> : <SubagentStatusIcon status={row.node.status} />}
                    </span>
                    {/* Issue #941: a finished agent/Stage row (never a tool row) gets green
                        name/label text alongside its icon's own `STATUS_GLYPH` colour -- applies
                        uniformly to a Stage header row (aggregate status) and an ordinary
                        member/solo row (its own status) alike. Gate round 1 fix (item 6,
                        MEDIUM): a Stage header's own label matches the chat pane's own
                        `CollapsedLine` label slot, which is regular weight since #1208; an ordinary
                        member/solo row stays unstyled text, unchanged from before #941 part 2. */}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        row.node.isStage && 'min-w-16',
                        isSubagentSuccessStatus(row.node.status) && SUBAGENT_SUCCESS_TEXT_CLASS
                      )}
                      title={row.node.nameOrTask}
                    >
                      {row.node.nameOrTask}
                    </span>
                    {/* Gate round 1 fix (issue #941 part 2, item 6, MEDIUM): a Stage header's own
                        "N done"/"N done, M failed" roll-up, `aria-hidden` since it is ALSO
                        folded into the row's own `aria-label` above (never announced twice).
                        Gate round 3 fix (item 1, MEDIUM): the status word the icon slot no
                        longer shows visibly moves in HERE instead, appended only while running --
                        a settled Stage's own "N done"/"N done, M failed" wording already states
                        failed/cancelled/exited, the same rule `StageGroupRow`'s own `meta` slot
                        uses (`SubagentChainRow.tsx`). Gate round 4 fix (item 1, MEDIUM, wrong
                        comment): the label gives up its own extra width first now, down to its
                        new `min-w-16` floor above; only once that floor is hit does this slot
                        start truncating itself. Gate round 4 fix (item 2, LOW): `title=` recovers
                        a truncated roll-up by mouse, same as the label span above already offers. */}
                    {row.node.isStage && row.node.rollupText && (
                      <span aria-hidden className="min-w-0 shrink truncate text-xs text-muted-foreground" title={stageRollupDisplayText(row.node)}>
                        {stageRollupDisplayText(row.node)}
                      </span>
                    )}
                    {!row.node.isStage && row.node.background && (
                      <span className="shrink-0 text-xs text-muted-foreground">Background</span>
                    )}
                    {!row.node.isStage && row.node.status !== 'running' && row.node.durationMs != null && (
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatElapsed(row.node.durationMs)}</span>
                    )}
                  </span>
                  {/* Gate round 1 fix (issue #941 part 2, item 3 decision): plain text, names
                      only, no "(Stage N)" suffix (see file header). Gate round 3 fix (item 1,
                      MEDIUM, wrong comment): indented to the label column, which is the Stage
                      header's own FIXED icon slot width (`w-4`, 16px) plus this row's own
                      `gap-2` (8px) = 24px, `pl-6` -- not the "icon slot's own `gap-2` width"
                      this comment previously (and wrongly) claimed; that gap only ever applies
                      BETWEEN two children of the icon wrapper, and the wrapper has always held
                      exactly one. */}
                  {row.node.isStage && row.node.usesText && (
                    <span className="pl-6 text-xs text-muted-foreground">{row.node.usesText}</span>
                  )}
                </div>
              ))}
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
                  <NoticeRow key={item.id} level={item.level} text={item.text} />
                ) : null
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </LinkContext.Provider>
  )
}
