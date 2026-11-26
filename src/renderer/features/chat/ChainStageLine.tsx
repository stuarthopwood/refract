import { cn } from '@/lib/utils'
import * as React from 'react'
import { ChevronRightIcon, PanelRightOpenIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { Button } from '@/components/ui/button'
import { FadeCollapse } from '@/components/FadeCollapse'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StageHeader } from '../subagents/card/StageHeader'
import { stageAccessibleName, stageAgentItemClass, stageAgentsGridClass, stageRowModel } from '../subagents/card/stageRowModel'
import type { SubAgentItem } from '../subagents/viewModel'
import { StageUsesLine } from './StageDependencies'
import { SpineItem, SpineList } from './SpineList'
import { SubagentRow } from './SubagentRow'
import { rowVisibility } from './transcriptRowVisibility'
import { JumpToStageContext } from './stageJump'
import { stageHeading } from './stageMeta'
import { useStickyDisclosure } from './useStickyDisclosure'
import type { StageGroup } from './groupSubagentStages'
import type { SubagentItem } from './subagentChainStatus'

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
  const { status } = stage.view
  const { parallelCount } = stageRowModel(stage.view)
  const { open: expanded, onOpenChange } = useStickyDisclosure(sessionId, stageToggleRowId(stage.id), status === 'running', { latch: false })
  const transcriptDisplay = useSettingsStore((s) => s.settings.transcriptDisplay)
  const jumpToStageRow = React.useContext(JumpToStageContext)
  const canJump = rowVisibility(stage, transcriptDisplay) === 'visible' && sessionId != null && jumpToStageRow != null
  const speechHeading = stageHeading(stage.stageIndex, stage.view.cleanTitle, true)
  return (
    <div role="group" aria-label={stageAccessibleName(stage.view)} className="@container text-sm" data-status={status}>
      <StageHeader
        stage={stage.view}
        expanded={expanded}
        // Without a jump button the column takes focus itself, so the outcome line stays reachable.
        columnFocusable={!canJump}
        renderTitle={
          canJump
            ? ({ label, colorClass }) => (
                <button
                  type="button"
                  className={cn(
                    'min-w-0 max-w-full cursor-pointer truncate rounded px-1 -mx-1 py-1 -my-1 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    colorClass
                  )}
                  aria-label={`Go to ${speechHeading}`}
                  onClick={() => jumpToStageRow(stage.id)}
                >
                  {label}
                </button>
              )
            : undefined
        }
        trailing={
          <Button type="button" variant="ghost" size="icon-xs" aria-expanded={expanded} aria-label={`${speechHeading} agents`} onClick={() => onOpenChange(!expanded)}>
            <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
          </Button>
        }
      />
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
