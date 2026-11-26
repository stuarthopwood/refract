// The panel's presentation: the card's header over a Stage/agent tree built from the same shared pieces (FR-150, ADR 0003).
// Keyboard and selection stay in SubagentPanel; this only draws rows and reports what the pointer did.
import type { KeyboardEvent } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ICON_SLOT_CLASS } from '../chat/CollapsedLine'
import { StageUsesLine } from '../chat/StageDependencies'
import { SubagentCardBody } from '../chat/SubagentRow'
import { stageHeading } from '../chat/stageMeta'
import { StageHeader } from './card/StageHeader'
import { SubagentsHeaderBelow, SubagentsHeaderMeta } from './card/SubagentsCardHeader'
import { formatHeaderTriggerLabel, stageSegmentStates } from './card/headerStats'
import type { PanelAgentRow, PanelRow, PanelStageRow } from './subagentPanelRows'
import { SubagentStatusGlyph, type SubagentRowStatus } from './subagentStatus'
import type { ChatScenario } from './viewModel'

const ROW_CLASS =
  'relative rounded-md text-left text-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'

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
      <SubagentsHeaderBelow stageStates={stageSegmentStates(scenario.stages)} goal={scenario.overallGoal} goalClassName="rounded-b-lg" />
    </div>
  )
}

interface RowHandlers {
  sessionId: string
  rowRef: (key: string, element: HTMLDivElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number) => void
  onFocusRow: (row: PanelAgentRow) => void
  onToggleStage: (stageId: string, open: boolean) => void
}

function StageTreeRow({ row, index, tabbable, handlers }: { row: PanelStageRow; index: number; tabbable: boolean; handlers: RowHandlers }) {
  const { stage, open } = row
  const heading = stageHeading(stage.number, stage.cleanTitle, true)
  return (
    <div
      ref={(element) => handlers.rowRef(row.key, element)}
      role="treeitem"
      aria-level={1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-expanded={open}
      aria-label={row.ariaLabel}
      tabIndex={tabbable ? 0 : -1}
      // A Stage has no single agent to stream, so focusing it selects nothing (issue #941 part 2).
      onKeyDown={(event) => handlers.onKeyDown(event, index)}
      className={cn(ROW_CLASS, 'py-1')}
      data-status={stage.status}
    >
      <StageHeader
        stage={stage}
        expanded={open}
        trailing={
          // The row itself takes Enter, Space and the arrow keys, so this stays out of the tab order and out of the one tab stop.
          <Button type="button" variant="ghost" size="icon-xs" tabIndex={-1} aria-label={`${open ? 'Collapse' : 'Expand'} ${heading}`} onClick={() => handlers.onToggleStage(stage.id, !open)}>
            <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
          </Button>
        }
      />
      {/* pl-8 = icon slot plus gap, so "Uses:" starts under the title, as on the card. */}
      <StageUsesLine dependencies={stage.dependencies} sessionId={handlers.sessionId} className="pl-8 pr-2" />
    </div>
  )
}

function AgentTreeRow({ row, index, tabbable, selected, handlers }: { row: PanelAgentRow; index: number; tabbable: boolean; selected: boolean; handlers: RowHandlers }) {
  return (
    <div
      ref={(element) => handlers.rowRef(row.key, element)}
      role="treeitem"
      aria-level={2}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-selected={selected}
      aria-label={row.ariaLabel}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => handlers.onFocusRow(row)}
      onKeyDown={(event) => handlers.onKeyDown(event, index)}
      // pl-6 puts the card under the Stage title; hover matches the other panel rows.
      className={cn(ROW_CLASS, 'ml-6 p-1 hover:bg-row-hover-bg')}
    >
      {selected && <ActiveIndicatorBar />}
      {/* Issue #712: a detached background job keeps its muted "Background" word. */}
      {row.agent.background && <span className="mb-1 block text-xs text-muted-foreground">Background</span>}
      <SubagentCardBody agent={row.agent} />
    </div>
  )
}

export function PanelTree({ rows, selectedKey, tabbableIndex, ...handlers }: { rows: readonly PanelRow[]; selectedKey: string | null; tabbableIndex: number } & RowHandlers) {
  return (
    <div role="tree" aria-label="Subagents" className="flex flex-col gap-1 py-2">
      {rows.map((row, index) =>
        row.kind === 'stage' ? (
          <StageTreeRow key={row.key} row={row} index={index} tabbable={index === tabbableIndex} handlers={handlers} />
        ) : (
          <AgentTreeRow key={row.key} row={row} index={index} tabbable={index === tabbableIndex} selected={row.key === selectedKey} handlers={handlers} />
        )
      )}
    </div>
  )
}
