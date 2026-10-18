// The Subagents panel (spec 004 FR-017 to FR-020, FR-024 to FR-027): the right-side pane's first
// occupant, opened by activating the Subagents chip. Shows the Session's subagents as a
// `role="tree"` (issue #563) in a vertical `ResizablePanelGroup` over the selected one's live
// stream (text and tool calls) through the same renderers the main transcript uses
// (`groupToolItems`/`ToolGroupRow` for tool calls, `Markdown` for text). Spec 013: its own title
// row and Close button moved to the shared shell (`PanelTabBar.tsx`) -- this component renders
// only the tree and stream content.
//
// Issue #941 part 2: every distinct `task()` call (`toolCallId`) with 2+ members now gets its
// own Stage HEADER treeitem (grouping, FR-079's deferred note), its real member rows nested at
// `aria-level + 1` beneath it -- a call with exactly ONE member stays a single flat row exactly
// as before (nothing to group). Green state (FR-079) applies uniformly to every row (header or
// member) via the same `isSubagentSuccessStatus` check the chat pane's `StageGroupRow` already
// uses. Gate round 1 decision (item 3, ui-architect-v3 ruling): a Stage header's own label
// NEVER shows "Stage N" -- the panel numbers Stages session-wide by `toolCallId`, the chat
// numbers per turn, so the SAME underlying Stage would show two disagreeing numbers across the
// two surfaces; the shared name prefix (else a bare "N agents") is shown instead, and a real
// "Uses:" dependency renders as plain NAMES ONLY (no "(Stage N)" suffix), via
// `groupSubagentPanelStages.ts`'s own `resolveStageDependencies` (shared with the chat pane).
// Scope boundary (documented, not an oversight): a SOLO call's own real dependency (if any) is
// not shown here -- there is no Stage header row for a single member to attach one to; it
// remains visible in the chat pane.
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
import { stageRollupText } from '../chat/stageMeta'
import { overallStatus } from '../chat/SubagentChainRow'
import { groupSubagentsIntoPanelStages } from './groupSubagentPanelStages'
import { isSubagentSuccessStatus, SUBAGENT_SUCCESS_TEXT_CLASS, SubagentStatusIcon, summarizeSubagentStatuses } from './subagentStatus'

interface SubagentTreeNode {
  id: string
  /** Gate round 3 fix (issue #941, HIGH): a composite `toolCallId:specIndex` key, unique per
   * subagent INSTANCE even when two share the same `id` (`SubagentSummary.id` is itself
   * `${toolCallId}:${nameOrTask}`, gate-fix -- NOT name-based alone, so two SEPARATE calls can
   * still collide on it when their own `nameOrTask` text happens to match too). Used for
   * React's own list `key`, the row-ref map, and which row shows selected/receives focus --
   * everywhere a specific RENDERED ROW, not merely "a row with this name", matters. A Stage
   * header row (issue #941 part 2) instead carries `stage:<toolCallId>` -- a format that can
   * never collide, since no real member key contains a colon-free `toolCallId` segment
   * (`specIndex` is always a plain integer). */
  key: string
  nameOrTask: string
  status: SubagentSummary['status']
  durationMs?: number
  children: SubagentTreeNode[]
  /** Issue #941 part 2: true only for a Stage HEADER row (2+ members) -- never selectable (no
   * single subagent id to show a stream for), its own `id` stays `''`. */
  isStage: boolean
  /** Present only on a Stage header row: the "N done"/"N done, M failed" roll-up
   * (`stageRollupText`, shared with the chat pane), shown in a trailing muted slot. */
  rollupText?: string
  /** Present only on a Stage header row, already formatted as plain text ("Uses: A, B") with
   * NO Stage-number suffix -- gate round 1 decision (issue #941 part 2, item 3, ui-architect-v3
   * ruling): the panel numbers Stages session-wide by `toolCallId` while the chat numbers
   * per-turn, so the same underlying Stage would show two DIFFERENT numbers across the two
   * surfaces; names only, scoped to earlier calls in the session, avoids the conflict instead
   * of trying to reconcile two genuinely different numbering schemes. `undefined` when the
   * Stage has no real dependency (the common case). */
  usesText?: string
  /** Present only on a Stage header row: the full accessible name (label/fallback PLUS the
   * roll-up, gate round 1 item 6) -- the visible text alone (`nameOrTask`) does not restate the
   * roll-up, which otherwise renders in a separate trailing `aria-hidden` slot. */
  ariaLabel?: string
}

/** FR-024 (issue #563): the Session is the implicit root (never rendered itself); these are its
 * first level, in start order -- each one either a single member row (a call with exactly one
 * subagent, unchanged from before #941 part 2) or a Stage header row with its real members
 * nested beneath (`groupSubagentsIntoPanelStages`, keyed on `toolCallId`, the only correlation
 * key `SubagentSummary` carries -- no `messageId`/`parentId` exists on it, so this is strictly
 * per-call, never merging several calls sharing one assistant message the way the chat pane's
 * own `messageId`-keyed grouping can). */
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
        children: [],
        isStage: false
      }
    }
    const counts = summarizeSubagentStatuses(stage.items.map((item) => item.status))
    const aggregateStatus = overallStatus(counts)
    // Gate round 1 decision (item 3): no "Stage N" prefix here (see `usesText`'s own comment) --
    // the shared name prefix when one exists, else a bare count ("N agents"), never a number
    // that would disagree with the chat pane's own per-turn Stage numbering for this same call.
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
        children: [],
        isStage: false
      })),
      isStage: true,
      rollupText,
      usesText,
      ariaLabel: `${label}, ${rollupText}`
    }
  })
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
  // Gate round 3 fix (issue #941, HIGH): WHICH rendered row shows selected/owns the one tab
  // stop, keyed by the unique `toolCallId:specIndex` composite (`SubagentTreeNode.key`), not
  // `selectedId` (the store's own name-based field, which two same-named agents both match).
  // Gate round 4 fix (issue #941, P1, HIGH): sourced from the STORE's `selectedKey`, not this
  // component's own `useState` -- a tab-switch remount (`RightPaneShell.tsx` unmounts this
  // panel while its tab is inactive) used to lose a local `selectedKey`, leaving no row
  // `aria-selected`/indicated and the roving tab stop falling to row 0 regardless of what was
  // actually selected. Falls back to the first row matching `selectedId` only when the store
  // itself has no specific instance (a name-only caller, or nothing selected yet) -- the same
  // ambiguous-match behaviour already accepted elsewhere, never worse.
  const effectiveSelectedKey = useMemo(() => {
    // Gate round 5 fix (issue #941, item 4, LOW): the stored key is used only when a CURRENT
    // row actually carries it -- a stale key (the agent list regenerated, e.g. a new turn
    // started, before `resetForNewTurn` cleared the store) would otherwise match no row at
    // all, silently selecting nothing instead of falling back to the same name-based match
    // every other ambiguous caller already accepts.
    if (storeSelectedKey && rows.some((row) => row.node.key === storeSelectedKey)) return storeSelectedKey
    if (!selectedId) return null
    return rows.find((row) => row.node.id === selectedId)?.node.key ?? null
  }, [storeSelectedKey, selectedId, rows])

  // PR #671's own roving-tabindex precedent (FileExplorerPanel.tsx): the ONE tab stop follows
  // the selected row, falling back to the first row once rendered rows exist but nothing is
  // selected yet, so Tab always has somewhere real to land.
  const tabbableIndex = useMemo(() => {
    if (rows.length === 0) return -1
    const found = rows.findIndex((row) => row.node.key === effectiveSelectedKey)
    return found === -1 ? 0 : found
  }, [rows, effectiveSelectedKey])

  // Decision 13 (issue #563); gate round 2 fix (High): opening the panel already pre-selected
  // on an agent (the chat pane's Stage/chain rows, via `openPanel`'s `selectSubagentId`)
  // focuses that row once it is mounted. One-shot (`pendingFocusSubagentId`/
  // `pendingFocusSubagentKey`, `subagent-store.ts`): the prior `focusRequestId` counter was
  // never consumed or reset, so this effect ran on EVERY mount while it still read > 0 --
  // stealing focus into the tree on a plain tab-switch away and back, or a remount returning
  // from Settings, long after the pre-selected open that set it. `clearPendingFocus()` consumes
  // the request the instant this effect focuses the row, so a later remount with no NEW
  // pre-selected open reads `null` and does nothing. Gate round 3 fix (issue #941, HIGH): the
  // composite key (when the caller resolved one, e.g. a Stage's own "Uses:" link) focuses the
  // EXACT matched row; a caller that only ever had a name (`pendingFocusSubagentId` alone)
  // falls back to the first row with that name -- the same ambiguity callers without a key
  // already had, never worse.
  const pendingFocusSubagentId = useSubagentPanelStore((s) => s.pendingFocusSubagentId)
  const pendingFocusSubagentKey = useSubagentPanelStore((s) => s.pendingFocusSubagentKey)
  const clearPendingFocus = useSubagentPanelStore((s) => s.clearPendingFocus)
  useEffect(() => {
    if (pendingFocusSubagentKey) {
      // Gate round 4 fix (issue #941, P1): no longer calls a local `setSelectedKey` -- the
      // store's own `selectedKey` was already set by `openPanel`'s own `selectSubagent` call
      // at open time (`subagent-store.ts`), so by the time this effect runs `selectedKey`
      // already reflects this instance; this effect's ONLY remaining job is moving real DOM
      // focus to the matching row.
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
        // Gate round 1 fix (issue #941 part 2, item 5): no longer a no-op -- a Stage header row
        // (2+ members) genuinely has real children one level deeper now (`buildSubagentTree`),
        // so this moves into the first one; an ordinary member/solo row (still no `children`
        // today, #712) keeps doing nothing, same as before.
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
      {/* FR-024: a vertical split, tree above stream -- the FileExplorerPanel.tsx tree/preview
          precedent (its own tabbed and resizable 60/20 over 40/15 split). */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60%" minSize="20%">
          {rows.length > 0 ? (
            <div role="tree" aria-label="Subagents" className="flex h-full flex-col gap-0.5 overflow-y-auto px-3 py-2">
              {rows.map((row, index) => (
                <div
                  key={row.node.key}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.node.key, el)
                    else rowRefs.current.delete(row.node.key)
                  }}
                  role="treeitem"
                  // Decision 12 (issue #563): `aria-level` always carries the TRUE depth, even
                  // though the visual indent below is capped at 3 levels.
                  aria-level={row.depth + 1}
                  aria-setsize={row.setsize}
                  aria-posinset={row.posinset}
                  // Gate round 1 fix (issue #941 part 2, item 5, MEDIUM): `aria-selected` is a
                  // SELECTION state -- a Stage header has no single subagent id to select, so it
                  // carries no `aria-selected` attribute at all (not `aria-selected="false"`,
                  // which would still claim "this is selectable, just not right now"). Always
                  // `true` on a Stage header's own `aria-expanded` (never collapsible, its real
                  // members are always shown nested beneath it) -- `undefined` (omitted) for an
                  // ordinary row, which has no children to expand at all.
                  aria-selected={row.node.isStage ? undefined : row.node.key === effectiveSelectedKey}
                  aria-expanded={row.node.isStage ? true : undefined}
                  aria-label={row.node.isStage ? row.node.ariaLabel : undefined}
                  tabIndex={index === tabbableIndex ? 0 : -1}
                  // Gate remediation (Medium, visual): the 2px `--active-indicator` bar below is
                  // `left-0`, so depth 0's prior 0px inset sat it directly on top of the status
                  // icon -- the 8px base inset (kept per-level/3-level cap below unchanged)
                  // gives the bar its own clear lane.
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
                    'relative flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left text-sm',
                    // Gate round 1 fix (issue #941 part 2, item 5, MEDIUM): a Stage header is not
                    // itself selectable/hoverable-as-a-target (it carries no `aria-selected`,
                    // see above) -- the hover affordance stays scoped to real, selectable rows.
                    !row.node.isStage && 'hover:bg-muted/50',
                    // Gate remediation (Medium, a11y across reviewers): the FileExplorerPanel.tsx
                    // tree-row precedent's own forced-colours selected fallback, reused verbatim
                    // so both trees are visually consistent and the selected row survives Windows
                    // High Contrast (where the `bg-active-indicator` bar below is itself repainted
                    // away). Gate round 2 (High) claimed `outline-hidden` fixed the Tailwind 4 trap
                    // (`outline-none` pins `outline-style: none` permanently) -- it did not:
                    // compiling this exact class list with the installed tailwindcss@4.3.3 shows
                    // `.outline-hidden` ALSO sets `--tw-outline-style: none` unconditionally
                    // (identical to `.outline-none`), and `.focus-visible\:outline-2:focus-visible`
                    // only ever reads that same custom property via `var(--tw-outline-style)`, so
                    // `outline-hidden` permanently won the cascade on that property regardless of
                    // focus state (round 3 architect finding M7, verified independently by Layout).
                    // Gate round 3 code/a11y spot check (Medium): a round-3 fix had kept
                    // `outline-hidden` alongside `focus-visible:outline-solid`, reasoning the
                    // latter wins the cascade on `:focus-visible` by coming later in Tailwind's
                    // canonical utility order -- the actual mechanism is specificity, not source
                    // order (`.focus-visible\:outline-solid:focus-visible` is a class PLUS a
                    // pseudo-class, strictly more specific than `.outline-hidden`'s bare class
                    // selector, so it always wins regardless of utility ordering). The real
                    // problem with keeping `outline-hidden`: its own `forced-colors` branch
                    // (`outline: 2px solid transparent`) applies to EVERY row, not just the
                    // focused one -- Windows High Contrast repaints that "transparent" outline
                    // visibly on every row, making the genuinely focused row barely
                    // distinguishable from its siblings. Dropped `outline-hidden` entirely; with
                    // no base `outline-*` utility, `--tw-outline-style` keeps its universal
                    // `solid` default, so `focus-visible:outline-2` paints on keyboard focus and
                    // nothing paints otherwise (no UA default outline survives Tailwind's reset) --
                    // matching every OTHER verified-working `focus-visible:outline-*` row in this
                    // codebase (`CollapsedLine.tsx`, `ManageSessionRow.tsx`, `ProfileItem.tsx`,
                    // `PullRequestRow.tsx`), none of which carry a base `outline-hidden` either.
                    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
                  )}
                >
                  {/* Decision 13 (issue #563): the selected node gets the shared 2px
                      `--active-indicator` bar (SessionList.tsx/ManageSessionRow.tsx precedent)
                      instead of a `bg-muted` background. */}
                  {row.node.key === effectiveSelectedKey && (
                    <span aria-hidden className="absolute inset-y-0.5 left-0 z-10 w-0.5 rounded-full bg-active-indicator" />
                  )}
                  <span className="flex w-full items-center gap-2">
                    <span className="flex shrink-0 items-center gap-1.5">
                      <SubagentStatusIcon status={row.node.status} />
                    </span>
                    {/* Issue #941: a finished agent/Stage row (never a tool row) gets green
                        name/label text alongside its icon's own `STATUS_GLYPH` colour -- applies
                        uniformly to a Stage header row (aggregate status) and an ordinary
                        member/solo row (its own status) alike. Gate round 1 fix (item 6,
                        MEDIUM): a Stage header's own label is `font-medium` (matching the chat
                        pane's own `CollapsedLine` label slot); an ordinary member/solo row stays
                        unstyled text, unchanged from before #941 part 2. */}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        row.node.isStage && 'font-medium',
                        isSubagentSuccessStatus(row.node.status) && SUBAGENT_SUCCESS_TEXT_CLASS
                      )}
                      title={row.node.nameOrTask}
                    >
                      {row.node.nameOrTask}
                    </span>
                    {/* Gate round 1 fix (issue #941 part 2, item 6, MEDIUM): a Stage header's own
                        "N done"/"N done, M failed" roll-up, `aria-hidden` since it is ALSO
                        folded into the row's own `aria-label` above (never announced twice). */}
                    {row.node.isStage && row.node.rollupText && (
                      <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
                        {row.node.rollupText}
                      </span>
                    )}
                    {!row.node.isStage && row.node.status !== 'running' && row.node.durationMs != null && (
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatElapsed(row.node.durationMs)}</span>
                    )}
                  </span>
                  {/* Gate round 1 fix (issue #941 part 2, item 3 decision): plain text, names
                      only, no "(Stage N)" suffix (see file header) -- indented to the label
                      column (the icon slot's own `gap-1.5` width, matching the label text
                      start above, not flush against the row's own left edge). */}
                  {row.node.isStage && row.node.usesText && (
                    <span className="pl-6 text-xs text-muted-foreground">{row.node.usesText}</span>
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
