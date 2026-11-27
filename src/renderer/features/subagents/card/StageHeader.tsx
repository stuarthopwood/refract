// The Stage header both the chat card and the panel draw (#1927, #1930, FR-147, FR-150): glyph, title, inline agent chip,
// "N parallel" badge, one-line outcome, duration and a trailing control. The caller owns what a click does.
import type * as React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ICON_SLOT_CLASS } from '../../chat/CollapsedLine'
import { formatElapsed } from '../../chat/formatElapsed'
import { stageHeading } from '../../chat/stageMeta'
import { DurationColumn } from '../../chat/toolRowParts'
import { SubagentStatusGlyph, subagentStatusTextClass } from '../subagentStatus'
import type { StageItem } from '../viewModel/types'
import { AgentChip } from './AgentChip'
import { ParallelBadge } from './ParallelBadge'
import { stageAccessibleName, stageRowModel } from './stageRowModel'

interface StageHeaderProps {
  stage: StageItem
  expanded: boolean
  /** Trailing control (the chevron); it takes the right edge, after the duration. */
  trailing: React.ReactNode
  /** Replaces the plain title text, for a caller that makes it a control. */
  renderTitle?: (title: { label: string; speechLabel: string; colorClass: string | undefined }) => React.ReactNode
  /** Makes the text column a tab stop; only for a caller with no other focusable thing in the header. */
  columnFocusable?: boolean
  /** Shows the whole outcome line instead of one truncated line; the panel sets it on the focused or selected row so keyboard users can read it. */
  fullOutcome?: boolean
}

/** A truncated outcome is only clipped when the Stage is collapsed and nobody asked for the full text. */
export function outcomeIsClamped(expanded: boolean, fullOutcome: boolean): boolean {
  return !expanded && !fullOutcome
}

export function StageHeader({ stage, expanded, trailing, renderTitle, columnFocusable = false, fullOutcome = false }: StageHeaderProps) {
  const { status, counts, durationMs, cleanTitle } = stage
  const label = stageHeading(stage.number, cleanTitle)
  const speechLabel = stageHeading(stage.number, cleanTitle, true)
  const { chipAgent, parallelCount, outcome, rawLabel } = stageRowModel(stage)
  const colorClass = subagentStatusTextClass(counts)
  return (
    // A tint, not a left border, marks the running Stage; the glyph and word still carry the status (#1927).
    <div className={cn('flex min-w-0 items-start gap-2 rounded px-2', status === 'running' && 'bg-state-working-tint')}>
      {/* Status is in the row's accessible name; the glyph keeps it from being colour-only. */}
      <span aria-hidden="true" className={ICON_SLOT_CLASS}>
        <SubagentStatusGlyph status={status} />
      </span>
      <Tooltip>
        {/* The column is the trigger so hovering the outcome line shows the full text too. */}
        <TooltipTrigger asChild>
          <div
            className="flex min-w-0 flex-1 flex-col rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            tabIndex={columnFocusable ? 0 : undefined}
            // A focusable column with no role has no name, so its outcome would be read without its Stage.
            role={columnFocusable ? 'group' : undefined}
            aria-label={columnFocusable ? stageAccessibleName(stage) : undefined}
          >
            <div className="flex min-w-0 items-center gap-2">
              {renderTitle ? renderTitle({ label, speechLabel, colorClass }) : <span className={cn('min-w-0 max-w-full truncate', colorClass)}>{label}</span>}
              {chipAgent && <AgentChip agent={chipAgent} />}
              <ParallelBadge count={parallelCount} />
            </div>
            {outcome && (
              <span className={cn('text-xs text-muted-foreground', outcomeIsClamped(expanded, fullOutcome) ? 'truncate' : 'break-words')} data-stage-outcome>
                {outcome}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start gap-1 break-words">
          <span>{label}</span>
          {rawLabel && <span className="text-muted-foreground">{rawLabel}</span>}
          {outcome && <span>{outcome}</span>}
        </TooltipContent>
      </Tooltip>
      {/* The shared duration column (#2189), kept when the Stage has no duration so the trailing control stays in one x. */}
      <DurationColumn aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
        {durationMs != null ? formatElapsed(durationMs) : null}
      </DurationColumn>
      <span className="shrink-0">{trailing}</span>
    </div>
  )
}
