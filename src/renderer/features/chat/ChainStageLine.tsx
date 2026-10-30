import { cn } from '@/lib/utils'
import * as React from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { StageUsesLine } from './StageDependencies'
import { rowVisibility } from './transcriptRowVisibility'
import { JumpToStageContext } from './stageJump'
import { formatElapsed } from './formatElapsed'
import { stageHeading } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'
import { overallStatus, stageSettleSummary, stageRunningSummary, stageTimeRange, type SubagentItem } from './subagentChainStatus'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph,
  SubagentStatusIcon,
  subagentStatusTextClass,
  summarizeSubagentStatuses
} from '../subagents/subagentStatus'

function ChainAgentEntry({ item, sessionId }: { item: SubagentItem; sessionId: string | null }) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  const status = chatRowStatus(item.status)
  const duration = item.durationMs != null ? formatElapsed(item.durationMs) : undefined
  const content = (
    <>
      <SubagentStatusIcon status={status} />
      <span className={cn('min-w-0 truncate', isSubagentSuccessStatus(status) && SUBAGENT_SUCCESS_TEXT_CLASS)} title={item.name}>
        {item.name}
      </span>
      {duration && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{duration}</span>}
    </>
  )
  if (!match || !sessionId) {
    return <span className="inline-flex max-w-48 items-center gap-1 px-2 py-1 text-sm text-muted-foreground">{content}</span>
  }
  return (
    <button
      type="button"
      className="inline-flex max-w-48 items-center gap-1 rounded px-2 py-1 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      onClick={(event) =>
        openHostedPanel('subagents', sessionId, {
          selectSubagentId: match.id,
          selectSubagentKey: `${match.toolCallId}:${match.specIndex}`,
          opener: event.currentTarget
        })
      }
    >
      {content}
    </button>
  )
}

// A labelled `role="group"` per stage: `SpineList`'s `<ol>` only gives an unlabelled "1 of 2".
export function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
  const counts = summarizeSubagentStatuses(stage.items.map((item) => chatRowStatus(item.status)))
  const status = overallStatus(counts)
  const summaryText = status === 'running' ? stageRunningSummary(counts, stage.items.length) : stageSettleSummary(stage)
  const { startedAt, endedAt } = stageTimeRange(stage.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const stageLabel = stageHeading(stage.stageIndex, stage.label)
  const speechHeading = stageHeading(stage.stageIndex, stage.label, true)
  const transcriptDisplay = useSettingsStore((s) => s.settings.transcriptDisplay)
  const jumpToStageRow = React.useContext(JumpToStageContext)
  const canJump = rowVisibility(stage, transcriptDisplay) === 'visible' && sessionId != null && jumpToStageRow != null
  const colorClass = subagentStatusTextClass(counts)
  return (
    <div
      role="group"
      aria-label={`${speechHeading}, ${summaryText}${status === 'running' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 text-sm"
      data-status={status}
    >
      {/* Status is in the group's accessible name; the glyph keeps it from being colour-only. */}
      <span aria-hidden="true" className="inline-flex shrink-0 items-center self-center">
        <SubagentStatusGlyph status={status} />
      </span>
      {canJump ? (
        <button
          type="button"
          title={`Go to ${stageLabel}`}
          className={cn(
            'min-w-0 max-w-full cursor-pointer truncate rounded px-1 -mx-1 py-1 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            colorClass
          )}
          aria-label={`Go to ${speechHeading}`}
          onClick={() => jumpToStageRow(stage.id)}
        >
          {stageLabel}
        </button>
      ) : (
        <span className={cn('min-w-0 max-w-full truncate', colorClass)} title={stageLabel}>
          {stageLabel}
        </span>
      )}
      {durationMs != null && (
        <span aria-hidden="true" className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {formatElapsed(durationMs)}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {stage.items.map((item) => (
          <ChainAgentEntry key={item.id} item={item} sessionId={sessionId} />
        ))}
      </div>
      <StageUsesLine dependencies={stage.dependencies} sessionId={sessionId} className="basis-full" />
    </div>
  )
}
