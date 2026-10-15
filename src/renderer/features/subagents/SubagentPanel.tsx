// The Subagents panel (spec 004 FR-017 to FR-020, FR-023 to FR-026): the right-side pane's first
// occupant, opened by activating the Subagents chip. Shows the Session's subagents as a
// `role="tree"` (issue #563) in a vertical `ResizablePanelGroup` over the selected one's live
// stream (text and tool calls) through the same renderers the main transcript uses
// (`groupToolItems`/`ToolGroupRow` for tool calls, `Markdown` for text). Spec 013: its own title
// row and Close button moved to the shared shell (`PanelTabBar.tsx`) -- this component renders
// only the tree and stream content.
import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
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
import { SubagentStatusIcon } from './subagentStatus'

interface SubagentTreeNode {
  id: string
  nameOrTask: string
  status: SubagentSummary['status']
  durationMs?: number
  children: SubagentTreeNode[]
}

/** FR-023 (issue #563): the Session is the implicit root (never rendered itself); these are its
 * first level, in start order. A node's own `children` would hold the agents IT started, once
 * the tracker can tell which agent started which -- no `parentId` exists on `SubagentSummary`
 * today, so every node's `children` is honestly empty until #712 supplies that data; nothing
 * here needs to change when it does, only this one function. */
export function buildSubagentTree(subagents: SubagentSummary[]): SubagentTreeNode[] {
  return subagents.map((subagent) => ({
    id: subagent.id,
    nameOrTask: subagent.nameOrTask,
    status: subagent.status,
    durationMs: subagent.durationMs,
    children: []
  }))
}

interface SubagentTreeRow {
  node: SubagentTreeNode
  depth: number
  posinset: number
  setsize: number
}

/** Depth-first flatten of `buildSubagentTree`'s own output into the renderer's one-pass list --
 * `aria-level`/`aria-setsize`/`aria-posinset` and the keyboard handler below all walk this flat
 * list by plain index arithmetic, never recursing themselves, so a later non-empty `children`
 * array nests correctly with no change to either. */
function flattenSubagentTree(nodes: SubagentTreeNode[], depth = 0): SubagentTreeRow[] {
  const rows: SubagentTreeRow[] = []
  nodes.forEach((node, index) => {
    rows.push({ node, depth, posinset: index + 1, setsize: nodes.length })
    rows.push(...flattenSubagentTree(node.children, depth + 1))
  })
  return rows
}

export function SubagentPanel({ sessionId }: { sessionId: string }) {
  // Spec 005 convergence (tasks.md T030): readout-store.ts is now per-session; this panel is
  // the one shared instance, explicitly bound to whichever pane's chip last activated it
  // (research.md Decision 10), so it always reads THIS sessionId's own subagent list.
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const selectedId = useSubagentPanelStore((s) => s.selectedId)
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

  // PR #671's own roving-tabindex precedent (FileExplorerPanel.tsx): the ONE tab stop follows
  // the selected row, falling back to the first row once rendered rows exist but nothing is
  // selected yet, so Tab always has somewhere real to land.
  const tabbableIndex = useMemo(() => {
    if (rows.length === 0) return -1
    const found = rows.findIndex((row) => row.node.id === selectedId)
    return found === -1 ? 0 : found
  }, [rows, selectedId])

  // Decision 13 (issue #563); gate remediation (code-reviewer H1/H2): opening the panel
  // already pre-selected on an agent (the chat pane's Stage/chain rows, via `openPanel`'s
  // `selectSubagentId`) focuses that row once it is mounted. Depends on `focusRequestId`
  // (`subagent-store.ts`, the `sideChatFocusRequestId` precedent), NOT `selectedId`: the prior
  // `selectedId` dependency reran on every mount with a retained id -- stealing focus back to
  // the tree on a plain tab-switch or a remount returning from Settings -- and never reran at
  // all when a chain/entry click re-targeted an agent that was ALREADY selected (`selectedId`
  // unchanged). `focusRequestId` only bumps for a genuine pre-selected open, covering both
  // cases, and fires exactly once per bump.
  const focusRequestId = useSubagentPanelStore((s) => s.focusRequestId)
  useEffect(() => {
    if (focusRequestId === 0) return
    const id = useSubagentPanelStore.getState().selectedId
    if (!id) return
    const el = rowRefs.current.get(id)
    el?.focus()
  }, [focusRequestId])

  function moveToRow(index: number): void {
    const row = rows[index]
    if (!row) return
    rowRefs.current.get(row.node.id)?.focus()
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
        // FR-024/#712: a deliberate no-op today -- no row's own depth is ever one more than
        // this one's, since `buildSubagentTree` gives every node an empty `children` until a
        // later story supplies parent ids. Moves to the first child the instant one exists.
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
    // Quality-gate fix (round 2): wraps the panel in the same `LinkContext` `Transcript.tsx`
    // provides for the main transcript, so a file link in a subagent's own stream (inline-code
    // path, or its own tool rows) resolves against this Session's worktree too, instead of
    // silently falling back to plain unstyled text just because this is a different mount point.
    <LinkContext.Provider value={sessionId}>
      {/* FR-023: a vertical split, tree above stream -- the FileExplorerPanel.tsx tree/preview
          precedent (its own tabbed and resizable 60/20 over 40/15 split). */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60%" minSize="20%">
          {rows.length > 0 ? (
            <div role="tree" aria-label="Subagents" className="flex h-full flex-col gap-0.5 overflow-y-auto px-3 py-2">
              {rows.map((row, index) => (
                <div
                  key={row.node.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.node.id, el)
                    else rowRefs.current.delete(row.node.id)
                  }}
                  role="treeitem"
                  // Decision 12 (issue #563): `aria-level` always carries the TRUE depth, even
                  // though the visual indent below is capped at 3 levels.
                  aria-level={row.depth + 1}
                  aria-setsize={row.setsize}
                  aria-posinset={row.posinset}
                  aria-selected={row.node.id === selectedId}
                  tabIndex={index === tabbableIndex ? 0 : -1}
                  // Gate remediation (Medium, visual): the 2px `--active-indicator` bar below is
                  // `left-0`, so depth 0's prior 0px inset sat it directly on top of the status
                  // icon -- the 8px base inset (kept per-level/3-level cap below unchanged)
                  // gives the bar its own clear lane.
                  style={{ paddingLeft: `${8 + Math.min(row.depth, 2) * 16}px` }}
                  onFocus={() => void selectSubagent(row.node.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, index)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-none',
                    // Gate remediation (Medium, a11y across reviewers): the FileExplorerPanel.tsx
                    // tree-row precedent's own focus ring and forced-colours selected fallback,
                    // reused verbatim so both trees are visually consistent and the selected row
                    // survives Windows High Contrast (where the `bg-active-indicator` bar below is
                    // itself repainted away).
                    'hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
                  )}
                >
                  {/* Decision 13 (issue #563): the selected node gets the shared 2px
                      `--active-indicator` bar (SessionList.tsx/ManageSessionRow.tsx precedent)
                      instead of a `bg-muted` background. */}
                  {row.node.id === selectedId && (
                    <span aria-hidden className="absolute inset-y-0.5 left-0 z-10 w-0.5 rounded-full bg-active-indicator" />
                  )}
                  <span className="flex shrink-0 items-center gap-1.5">
                    <SubagentStatusIcon status={row.node.status} />
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.node.nameOrTask}>
                    {row.node.nameOrTask}
                  </span>
                  {row.node.status !== 'running' && row.node.durationMs != null && (
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatElapsed(row.node.durationMs)}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            // Gate remediation (Medium, a11y): a `<p>` is not a permitted child of `role="tree"`
            // (ARIA's required-owned-elements rule) -- rendered as a sibling instead, only when
            // the tree itself has nothing to show. Decision 24 plus the Session-wide (not
            // turn-scoped) definition this panel now uses: "No agents running.", not "this turn".
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No agents running.</p>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize agent tree and stream" />
        <ResizablePanel defaultSize="40%" minSize="15%">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-2 px-3 py-2">
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
