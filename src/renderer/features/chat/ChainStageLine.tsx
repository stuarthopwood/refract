import { cn } from '@/lib/utils'
import * as React from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentChip } from '../subagents/card/AgentChip'
import { ParallelBadge } from '../subagents/card/ParallelBadge'
import { stageAgentItemClass, stageAgentsGridClass, stageRowModel } from '../subagents/card/stageRowModel'
import { StageUsesLine } from './StageDependencies'
import { ICON_SLOT_CLASS } from './CollapsedLine'
import { SpineItem, SpineList } from './SpineList'
import { rowVisibility } from './transcriptRowVisibility'
import { JumpToStageContext } from './stageJump'
import { formatElapsed } from './formatElapsed'
import { stageHeading } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'
import type { SubagentItem } from './subagentChainStatus'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph,
  subagentStatusTextClass
} from '../subagents/subagentStatus'

function ChainAgentEntry({ item, sessionId }: { item: SubagentItem; sessionId: string | null }) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  const status = chatRowStatus(item.status)
  const duration = item.durationMs != null ? formatElapsed(item.durationMs) : undefined
  // The glyph alone sits in the shared icon slot (its sr-only word keeps the accessible name); the visible word follows the name.
  const content = (
    <>
      <span className={ICON_SLOT_CLASS}>
        <SubagentStatusGlyph status={status} />
      </span>
      <span className={cn('min-w-0 truncate', isSubagentSuccessStatus(status) && SUBAGENT_SUCCESS_TEXT_CLASS)} title={item.name}>
        {item.name}
      </span>
      {status !== 'finished' && (
        <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {duration && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{duration}</span>}
    </>
  )
  if (!match || !sessionId) {
    return <span className="flex w-fit max-w-full items-center gap-2 px-2 text-sm text-muted-foreground">{content}</span>
  }
  return (
    <button
      type="button"
      className="flex w-fit max-w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
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
// `expanded` hides the agent list and lets the outcome wrap; the header, chip and badge always show (#1927).
export function ChainStageLine({ stage, sessionId, expanded = true }: { stage: StageGroup; sessionId: string | null; expanded?: boolean }) {
  const { status, counts, rollupText: summaryText, durationMs, cleanTitle } = stage.view
  const stageLabel = stageHeading(stage.stageIndex, cleanTitle)
  const speechHeading = stageHeading(stage.stageIndex, cleanTitle, true)
  const { chipAgent, parallelCount, outcome, rawLabel } = stageRowModel(stage.view)
  const transcriptDisplay = useSettingsStore((s) => s.settings.transcriptDisplay)
  const jumpToStageRow = React.useContext(JumpToStageContext)
  const canJump = rowVisibility(stage, transcriptDisplay) === 'visible' && sessionId != null && jumpToStageRow != null
  const colorClass = subagentStatusTextClass(counts)
  return (
    <div
      role="group"
      aria-label={`${speechHeading}, ${summaryText}${status === 'running' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      className="@container text-sm"
      data-status={status}
    >
      {/* A tint, not a left border, marks the running Stage; the glyph and word still carry the status (#1927). */}
      <div
        className={cn(
          'flex min-w-0 items-start gap-2 rounded px-2',
          status === 'running' && 'bg-[color-mix(in_oklab,var(--state-working)_10%,transparent)]'
        )}
      >
        {/* Status is in the group's accessible name; the glyph keeps it from being colour-only. */}
        <span aria-hidden="true" className={ICON_SLOT_CLASS}>
          <SubagentStatusGlyph status={status} />
        </span>
        <Tooltip>
          {/* The column is the trigger so hovering the outcome line shows the full text too; without a jump button it takes focus itself. */}
          <TooltipTrigger asChild>
            <div
              className="flex min-w-0 flex-1 flex-col rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              tabIndex={canJump ? undefined : 0}
            >
              <div className="flex min-w-0 items-center gap-2">
                {canJump ? (
                  <button
                    type="button"
                    className={cn(
                      'min-w-0 max-w-full cursor-pointer truncate rounded px-1 -mx-1 py-1 -my-1 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      colorClass
                    )}
                    aria-label={`Go to ${speechHeading}`}
                    onClick={() => jumpToStageRow(stage.id)}
                  >
                    {stageLabel}
                  </button>
                ) : (
                  <span className={cn('min-w-0 max-w-full truncate', colorClass)}>{stageLabel}</span>
                )}
                {chipAgent && <AgentChip agent={chipAgent} />}
                <ParallelBadge count={parallelCount} />
              </div>
              {outcome && (
                <span className={cn('text-xs text-muted-foreground', expanded ? 'break-words' : 'truncate')} data-stage-outcome>
                  {outcome}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="flex-col items-start gap-1 break-words">
            <span>{stageLabel}</span>
            {rawLabel && <span className="text-muted-foreground">{rawLabel}</span>}
            {outcome && <span>{outcome}</span>}
          </TooltipContent>
        </Tooltip>
        {durationMs != null && (
          <span aria-hidden="true" className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
            {formatElapsed(durationMs)}
          </span>
        )}
      </div>
      {/* pl-8 = icon slot plus gap, so "Uses:" starts under the title. */}
      <StageUsesLine dependencies={stage.view.dependencies} sessionId={sessionId} className="pl-8 pr-2" />
      {expanded && (
        <SpineList elbows className={stageAgentsGridClass(parallelCount)}>
          {stage.items.map((item) => (
            <SpineItem key={item.id} isNew={false} className={stageAgentItemClass(parallelCount)}>
              <ChainAgentEntry item={item} sessionId={sessionId} />
            </SpineItem>
          ))}
        </SpineList>
      )}
    </div>
  )
}
