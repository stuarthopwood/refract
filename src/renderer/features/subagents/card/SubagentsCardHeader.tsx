// The Subagents card shell: status glyph, "Subagents", the stats, "Running · duration" and the chevron in the
// trigger, with the segmented stage bar and the Goal strip under it, outside the trigger so the progressbar keeps its role.
import type * as React from 'react'
import { ProgressStrip } from '@/components/ProgressStrip'
import { cn } from '@/lib/utils'
import { CollapsedLine } from '../../chat/CollapsedLine'
import { formatElapsed } from '../../chat/formatElapsed'
import { stageHeading } from '../../chat/stageMeta'
import { SUBAGENT_STATUS_LABEL, SubagentStatusGlyph, type SubagentRowStatus } from '../subagentStatus'
import type { StageItem } from '../viewModel/types'
import { GoalStrip } from './GoalStrip'
import { formatHeaderTriggerLabel, formatProgressText, formatProgressValueText, stageSegmentStates } from './headerStats'

/** What a segment's label reads from; `number` is the Session-wide Stage number, so a label never shifts when a Stage leaves the surface. */
export type StageLabelSource = Pick<StageItem, 'number' | 'cleanTitle' | 'status' | 'durationMs'>

/** "Stage 3 · Fix the build · Running · 13m 53s" for each Stage, in the order of the segments; the duration is dropped until the Stage has one. */
export function stageSegmentLabels(stages: readonly StageLabelSource[]): string[] {
  return stages.map((stage) =>
    [stageHeading(stage.number, stage.cleanTitle), SUBAGENT_STATUS_LABEL[stage.status], ...(stage.durationMs != null ? [formatElapsed(stage.durationMs)] : [])].join(' \u00b7 ')
  )
}

export interface SubagentsCardHeaderProps {
  status: SubagentRowStatus
  /** The view-model's `headerStats` ("3 stages, 5 agents, 1 running"). */
  headerStats: string
  /** The Stages in order: one segment, one tooltip label and one "X of Y" count each, so a label can never be dropped or misaligned. */
  stages: readonly StageLabelSource[]
  /** The view-model's `overallGoal`; the strip is absent without one. */
  goal?: string
  /** Wall-clock so far while running, the total once settled; absent until a Stage has a start. */
  durationMs?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Sibling of the trigger (the "Show subagents panel" button). */
  action?: React.ReactNode
  className?: string
  contentClassName?: string
  /** The Stage list. */
  children?: React.ReactNode
}

/** "Running · 1m 2s" beside the stats. */
export function SubagentsHeaderMeta({ status, durationMs }: { status: SubagentRowStatus; durationMs: number | undefined }) {
  const statusVisible = status !== 'finished'
  // aria-hidden: the trigger's name states the status and settled duration, so the ticking visible copy must not be read out.
  return (
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      {statusVisible && (
        <span className="min-w-0 truncate" title={SUBAGENT_STATUS_LABEL[status]}>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {durationMs != null && (
        // The separator lives in the hideable span so hiding the duration never leaves a dangling "·".
        <span className="@max-[20rem]:hidden whitespace-nowrap">
          {statusVisible && <span> · </span>}
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
    </span>
  )
}

/** The live region's text when every Stage settles; only the chat card announces, so the panel next to it passes `false` and stays silent. */
export function stagesDoneText(announceDone: boolean): string | undefined {
  return announceDone ? 'All stages done' : undefined
}

/** The segmented stage bar and the Goal strip under a header. `announceDone={false}` keeps a second surface silent: only the chat card speaks "All stages done". */
export function SubagentsHeaderBelow({
  stages,
  goal,
  goalClassName,
  announceDone = true
}: {
  stages: readonly StageLabelSource[]
  goal?: string
  goalClassName?: string
  announceDone?: boolean
}) {
  const stageStates = stageSegmentStates(stages)
  const total = stageStates.length
  const done = stageStates.filter((state) => state === 'done').length
  const segmentLabels = stageSegmentLabels(stages)
  return (
    <>
      {total > 0 && (
        <ProgressStrip
          className="px-2 pb-2"
          label={formatProgressText(done, total)}
          value={done}
          max={total}
          segments={stageStates}
          segmentLabels={segmentLabels}
          valueText={formatProgressValueText(done, total)}
          doneText={stagesDoneText(announceDone)}
        />
      )}
      <GoalStrip goal={goal} className={goalClassName} />
    </>
  )
}

export function SubagentsCardHeader({
  status,
  headerStats,
  stages,
  goal,
  durationMs,
  open,
  onOpenChange,
  action,
  className,
  contentClassName,
  children
}: SubagentsCardHeaderProps) {
  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label="Subagents"
      summary={headerStats}
      summaryWrap
      meta={<SubagentsHeaderMeta status={status} durationMs={durationMs} />}
      metaClassName="min-w-0 shrink"
      open={open}
      onOpenChange={onOpenChange}
      className={cn('rounded-lg bg-chat-card-bg ring-1 ring-divider', className)}
      triggerClassName="group-hover/line:bg-row-hover-bg"
      contentClassName={contentClassName}
      triggerAriaLabel={formatHeaderTriggerLabel(headerStats, status, durationMs)}
      action={action}
      belowHeader={<SubagentsHeaderBelow stages={stages} goal={goal} goalClassName={open ? undefined : 'rounded-b-lg'} />}
    >
      {children}
    </CollapsedLine>
  )
}
