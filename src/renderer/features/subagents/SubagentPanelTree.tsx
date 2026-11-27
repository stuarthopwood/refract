// The panel's presentation: the card's header over a Stage/agent tree built from the same shared pieces (FR-150, ADR 0003).
// Keyboard and selection stay in SubagentPanel; this only draws rows and reports what the pointer did.
import { memo, useEffect, useId, useState } from 'react'
import type { FocusEvent, KeyboardEvent } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { FileChipList, FileChipTabbableContext } from '@/components/FileChip'
import { IconButton } from '@/components/IconButton'
import { cn } from '@/lib/utils'
import { ICON_SLOT_CLASS } from '../chat/CollapsedLine'
import { StageUsesLine } from '../chat/StageDependencies'
import { SUBAGENT_CARD_SURFACE_CLASS, SubagentCardBody, flatBodyHasContent } from '../chat/SubagentRow'
import { stageHeading } from '../chat/stageMeta'
import { StageHeader } from './card/StageHeader'
import { repeatsStageTitle } from './card/stageRowModel'
import { ResultMarkdown } from './card/ResultMarkdown'
import { SubagentsHeaderBelow, SubagentsHeaderMeta } from './card/SubagentsCardHeader'
import { formatHeaderTriggerLabel, stageSegmentStates } from './card/headerStats'
import { panelDurationMs, type PanelAgentRow, type PanelRow, type PanelStageRow } from './subagentPanelRows'
import { SubagentStatusGlyph, type SubagentRowStatus } from './subagentStatus'
import { FILES_TOUCHED_LABEL, type ChatScenario, type SubAgentItem } from './viewModel'

const ROW_CLASS =
  'relative rounded-md text-left text-sm focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'

// The row the developer is on shows its whole outcome: a clamped line is unreadable from the keyboard, where there is no hover tooltip.
const FULL_OUTCOME_CLASS = 'aria-selected:[&_p]:line-clamp-none focus:[&_p]:line-clamp-none'

/** The goal, the segmented Stage bar and the roll-up: the same header the chat card draws, minus its disclosure. */
export function PanelHeader({ scenario, status, durationMs }: { scenario: ChatScenario; status: SubagentRowStatus; durationMs: number | undefined }) {
  return (
    <div role="group" aria-label={formatHeaderTriggerLabel(scenario.headerStats, status, durationMs)} className="shrink-0 rounded-lg bg-chat-card-bg ring-1 ring-divider">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-sm">
        <span aria-hidden="true" className={ICON_SLOT_CLASS}>
          <SubagentStatusGlyph status={status} />
        </span>
        <span className="shrink-0">Subagents</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={scenario.headerStats}>
          {scenario.headerStats}
        </span>
        <SubagentsHeaderMeta status={status} durationMs={durationMs} />
      </div>
      {/* The panel sits beside the chat card, which already announces "All stages done". */}
      <SubagentsHeaderBelow stageStates={stageSegmentStates(scenario.stages)} goal={scenario.overallGoal} goalClassName="rounded-b-lg" announceDone={false} />
    </div>
  )
}

/** The header with its own one-second clock: only this small subtree re-renders each tick, not the tree and the stream below it. */
export const LivePanelHeader = memo(function LivePanelHeader({ scenario, status }: { scenario: ChatScenario; status: SubagentRowStatus }) {
  const running = status === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [running])
  return <PanelHeader scenario={scenario} status={status} durationMs={panelDurationMs(scenario, running, now)} />
})

interface RowHandlers {
  sessionId: string
  rowRef: (key: string, element: HTMLDivElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number) => void
  onFocusRow: (row: PanelAgentRow) => void
  onToggleStage: (stageId: string, open: boolean) => void
}

/** The row's description node: hidden (a described-by reference still reads it), so the visible text is not spoken twice in browse mode. */
function RowDescription({ id, text }: { id: string; text: string }) {
  return text ? (
    <span id={id} hidden>
      {text}
    </span>
  ) : null
}

type StageTreeRowProps = { row: PanelStageRow; index: number; tabbable: boolean } & Pick<RowHandlers, 'sessionId' | 'rowRef' | 'onKeyDown' | 'onToggleStage'>

const StageTreeRow = memo(function StageTreeRow({ row, index, tabbable, sessionId, rowRef, onKeyDown, onToggleStage }: StageTreeRowProps) {
  const { stage, open } = row
  const heading = stageHeading(stage.number, stage.cleanTitle, true)
  const descriptionId = useId()
  const [focused, setFocused] = useState(false)
  return (
    <div
      ref={(element) => rowRef(row.key, element)}
      role="treeitem"
      aria-level={1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-expanded={open}
      aria-label={row.ariaLabel}
      aria-describedby={row.description ? descriptionId : undefined}
      tabIndex={tabbable ? 0 : -1}
      // A Stage has no single agent to stream, so focusing it selects nothing (issue #941 part 2).
      onKeyDown={(event) => onKeyDown(event, index)}
      onFocus={() => setFocused(true)}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      className={cn(ROW_CLASS, 'rounded-none', row.posinset > 1 && 'border-t border-divider')}
      data-status={stage.status}
    >
      <StageHeader
        stage={stage}
        expanded={open}
        fullOutcome={focused}
        trailing={
          // The row itself takes Enter, Space and the arrow keys, so this stays out of the tab order and out of the one tab stop.
          <IconButton variant="ghost" size="icon-xs" tabIndex={-1} label={`${open ? 'Collapse' : 'Expand'} ${heading}`} onClick={() => onToggleStage(stage.id, !open)}>
            <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
          </IconButton>
        }
      />
      {/* pl-10 = the row's px-4, the 16px status column and its 8px gap, so "Uses:" starts under the title, as on the card. These links stay tab stops: they are the only
          keyboard route to the agent a Stage depends on, the tree has no jump key, and the Stage's name already lists them. */}
      <StageUsesLine dependencies={stage.dependencies} sessionId={sessionId} className="pl-10 pr-4" />
      <RowDescription id={descriptionId} text={row.description} />
    </div>
  )
})

type AgentTreeRowProps = { row: PanelAgentRow; index: number; tabbable: boolean; selected: boolean } & Pick<RowHandlers, 'rowRef' | 'onKeyDown' | 'onFocusRow'>

const AgentTreeRow = memo(function AgentTreeRow({ row, index, tabbable, selected, rowRef, onKeyDown, onFocusRow }: AgentTreeRowProps) {
  const descriptionId = useId()
  // A Stage with one agent expands flat, as on the chat card: a guide line at the 40px mark, no second card repeating the Stage's name or outcome (FR-176).
  const flat = row.setsize === 1
  // A row that would otherwise draw nothing names its agent, so the keyboard target is never an empty, invisible row.
  const fallbackLabel = repeatsStageTitle(row.agent.name, row.stageTitle) && flatBodyHasContent(row.agent) ? undefined : row.agent.name
  return (
    <div
      ref={(element) => rowRef(row.key, element)}
      role="treeitem"
      aria-level={2}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-selected={selected}
      aria-label={row.ariaLabel}
      aria-describedby={row.description ? descriptionId : undefined}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocusRow(row)}
      onKeyDown={(event) => onKeyDown(event, index)}
      // ml-10 puts the agent under the Stage title, as on the chat card. A parallel agent is a bordered card; a lone one is flat and its row
      // has no padding of its own. The hover fill is the surface step, which stays visible on the card fill where `row-hover-bg` does not.
      className={cn(ROW_CLASS, FULL_OUTCOME_CLASS, 'ml-10 mr-4 hover:bg-surface-hover', flat ? 'rounded-none' : cn(SUBAGENT_CARD_SURFACE_CLASS, 'my-2'))}
    >
      {selected && <ActiveIndicatorBar />}
      {/* Issue #712: a detached background job keeps its muted "Background" word. */}
      {row.agent.background && <span className="mb-1 block text-xs text-muted-foreground">Background</span>}
      {/* The row is the one tab stop, so the card's "+N" files button is not: the detail pane lists every file. */}
      <FileChipTabbableContext.Provider value={false}>
        <SubagentCardBody agent={row.agent} flat={flat} fallbackLabel={fallbackLabel} />
      </FileChipTabbableContext.Provider>
      <RowDescription id={descriptionId} text={row.description} />
    </div>
  )
})

/** The selected agent's whole outcome and every file it touched, which the tree row clamps and folds behind "+N". */
export function AgentDetailSummary({ agent }: { agent: SubAgentItem }) {
  const outcome = agent.whatItDid?.trim()
  const files = agent.filesTouched ?? []
  if (!outcome && files.length === 0) return null
  return (
    <section aria-label={`${agent.name} details`} className="space-y-1 px-1">
      {outcome && <ResultMarkdown text={outcome} interactive className="break-words text-sm text-card-foreground" />}
      <FileChipList files={files} label={FILES_TOUCHED_LABEL} limit={files.length} />
    </section>
  )
}

export function PanelTree({ rows, selectedKey, tabbableIndex, sessionId, rowRef, onKeyDown, onFocusRow, onToggleStage }: { rows: readonly PanelRow[]; selectedKey: string | null; tabbableIndex: number } & RowHandlers) {
  return (
    <div role="tree" aria-label="Subagents" className="flex flex-col py-2">
      {rows.map((row, index) =>
        row.kind === 'stage' ? (
          <StageTreeRow key={row.key} row={row} index={index} tabbable={index === tabbableIndex} sessionId={sessionId} rowRef={rowRef} onKeyDown={onKeyDown} onToggleStage={onToggleStage} />
        ) : (
          <AgentTreeRow key={row.key} row={row} index={index} tabbable={index === tabbableIndex} selected={row.key === selectedKey} rowRef={rowRef} onKeyDown={onKeyDown} onFocusRow={onFocusRow} />
        )
      )}
    </div>
  )
}
