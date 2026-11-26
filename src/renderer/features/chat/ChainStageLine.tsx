import { cn } from '@/lib/utils'
import * as React from 'react'
import { ChevronRightIcon, PanelRightOpenIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { Button } from '@/components/ui/button'
import { FadeCollapse } from '@/components/FadeCollapse'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentChip } from '../subagents/card/AgentChip'
import { ParallelBadge } from '../subagents/card/ParallelBadge'
import { stageAgentItemClass, stageAgentsGridClass, stageRowModel } from '../subagents/card/stageRowModel'
import type { SubAgentItem } from '../subagents/viewModel'
import { StageUsesLine } from './StageDependencies'
import { ICON_SLOT_CLASS } from './CollapsedLine'
import { SpineItem, SpineList } from './SpineList'
import { SubagentRow } from './SubagentRow'
import { rowVisibility } from './transcriptRowVisibility'
import { JumpToStageContext } from './stageJump'
import { formatElapsed } from './formatElapsed'
import { stageHeading } from './stageMeta'
import { useStickyDisclosure } from './useStickyDisclosure'
import type { StageGroup } from './groupSubagentStages'
import type { SubagentItem } from './subagentChainStatus'
import { SUBAGENT_STATUS_LABEL, SubagentStatusGlyph, subagentStatusTextClass } from '../subagents/subagentStatus'

/** The Stage's own toggle key; `card:` keeps it apart from `StageGroupRow`'s bare id and the panel's `panel:` keys (FR-150 d). */
export const stageToggleRowId = (stageId: string): string => `card:${stageId}`

function ChainAgentEntry({ item, agent, sessionId }: { item: SubagentItem; agent: SubAgentItem; sessionId: string | null }) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  return (
    <div className="flex min-w-0 items-start gap-1">
      <div className="min-w-0 flex-1">
        <SubagentRow item={item} agent={agent} showGoal={false} variant="card" />
      </div>
      {match && sessionId && (
        <Tooltip>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={`Open ${item.name} in the subagents panel`}
              onClick={(event) =>
                openHostedPanel('subagents', sessionId, {
                  selectSubagentId: match.id,
                  selectSubagentKey: `${match.toolCallId}:${match.specIndex}`,
                  opener: event.currentTarget
                })
              }
            >
              <PanelRightOpenIcon aria-hidden className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in subagents panel</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

// A labelled `role="group"` per stage: `SpineList`'s `<ol>` only gives an unlabelled "1 of 2".
// A running Stage opens and a settled one collapses on its own; the developer's own toggle wins for the Session (FR-149).
// The header and outcome always show, and the chevron is a plain button so automatic changes never move focus.
export function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
  const { status, counts, rollupText: summaryText, durationMs, cleanTitle } = stage.view
  const stageLabel = stageHeading(stage.stageIndex, cleanTitle)
  const speechHeading = stageHeading(stage.stageIndex, cleanTitle, true)
  const { chipAgent, parallelCount, outcome, rawLabel } = stageRowModel(stage.view)
  const { open: expanded, onOpenChange } = useStickyDisclosure(sessionId, stageToggleRowId(stage.id), status === 'running', { latch: false })
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn('shrink-0', durationMs == null && 'ml-auto')}
          aria-expanded={expanded}
          aria-label={`${speechHeading} agents`}
          onClick={() => onOpenChange(!expanded)}
        >
          <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
        </Button>
      </div>
      {/* pl-8 = icon slot plus gap, so "Uses:" starts under the title. */}
      <StageUsesLine dependencies={stage.view.dependencies} sessionId={sessionId} className="pl-8 pr-2" />
      {/* aria-live="off": inside the transcript's role="log", so an automatic expand is not announced as a log addition. */}
      <FadeCollapse show={expanded}>
        <div aria-live="off">
          <SpineList elbows className={stageAgentsGridClass(parallelCount)}>
            {stage.items.map((item, index) => (
              <SpineItem key={item.id} isNew={false} className={stageAgentItemClass(parallelCount)}>
                <ChainAgentEntry item={item} agent={stage.view.agents[index]!} sessionId={sessionId} />
              </SpineItem>
            ))}
          </SpineList>
        </div>
      </FadeCollapse>
    </div>
  )
}
