// The Stage header both the chat card and the panel draw (#1927, #1930, #2318, FR-147, FR-150, FR-175): one `grid-cols-[18px_1fr_auto]` row.
// Column 1 is the status tick, column 2 the muted Stage number, the foreground title, quiet metadata and the outcome line, column 3 the
// tabular duration and the trailing control. The caller owns what a click does.
import type * as React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatElapsed } from '../../chat/formatElapsed'
import { stageHeading } from '../../chat/stageMeta'
import { DurationColumn } from '../../chat/toolRowParts'
import { SubagentStatusGlyph, subagentStatusTextClass } from '../subagentStatus'
import type { StageItem } from '../viewModel/types'
import { AgentChip } from './AgentChip'
import { ResultMarkdown } from './ResultMarkdown'
import { ParallelBadge } from './ParallelBadge'
import { stageAccessibleName, stageRowModel } from './stageRowModel'

/** The Stage title as a caller gets it to wrap in a control: the muted number and the title already laid out, plus the spoken form. */
export interface StageTitleParts {
  content: React.ReactNode
  speechLabel: string
}

interface StageHeaderProps {
  stage: StageItem
  expanded: boolean
  /** Trailing control (the chevron); it takes the right edge, after the duration. */
  trailing: React.ReactNode
  /** Replaces the plain title text, for a caller that makes it a control. */
  renderTitle?: (title: StageTitleParts) => React.ReactNode
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
  const { chipAgent, parallelCount, outcome, outcomePlain, rawLabel } = stageRowModel(stage)
  const running = status === 'running'
  // Titles stay foreground; only a failure recolours one, and a settled Stage's tick alone is green.
  const titleClass = cn(subagentStatusTextClass(counts), running && 'font-medium')
  const title = (
    <>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">Stage {stage.number}</span>
      {cleanTitle && (
        <>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            &middot;
          </span>
          <span className={cn('min-w-0 truncate', titleClass)}>{cleanTitle}</span>
        </>
      )}
    </>
  )
  return (
    // A tint, not a left border, marks the running Stage; the glyph and word still carry the status (#1927).
    <div className={cn('grid min-w-0 grid-cols-[18px_1fr_auto] items-start gap-x-2.5 rounded px-2 py-2', running && 'bg-state-working-tint forced-colors:border')}>
      {/* Status is in the row's accessible name; the glyph keeps it from being colour-only. */}
      <span aria-hidden="true" className="flex h-5 items-center justify-center">
        <SubagentStatusGlyph status={status} />
      </span>
      <Tooltip>
        {/* The column is the trigger so hovering the outcome line shows the full text too. */}
        <TooltipTrigger asChild>
          <div
            className="flex min-w-0 flex-col rounded focus-visible:outline-(length:--focus-ring-width) focus-visible:-outline-offset-2 focus-visible:outline-ring"
            tabIndex={columnFocusable ? 0 : undefined}
            // A focusable column with no role has no name, so its outcome would be read without its Stage.
            role={columnFocusable ? 'group' : undefined}
            aria-label={columnFocusable ? stageAccessibleName(stage) : undefined}
          >
            <div className="flex min-h-5 min-w-0 items-center gap-2">
              {renderTitle ? renderTitle({ content: title, speechLabel }) : title}
              {chipAgent && <AgentChip agent={chipAgent} />}
              <ParallelBadge count={parallelCount} />
            </div>
            {outcome && (
              <div className="text-xs text-muted-foreground" data-stage-outcome>
                <ResultMarkdown text={outcome} lines={outcomeIsClamped(expanded, fullOutcome) ? 1 : 'all'} />
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start gap-1 break-words">
          <span>{label}</span>
          {rawLabel && <span className="text-muted-foreground">{rawLabel}</span>}
          {outcomePlain && <span>{outcomePlain}</span>}
        </TooltipContent>
      </Tooltip>
      {/* The shared duration column (#2189), kept when the Stage has no duration so the one chevron stays in one x. */}
      <div className="flex items-center gap-1">
        <DurationColumn aria-hidden="true" className={cn('text-xs', running ? 'font-medium text-state-working' : 'text-muted-foreground')}>
          {durationMs != null ? formatElapsed(durationMs) : null}
        </DurationColumn>
        <span className="shrink-0">{trailing}</span>
      </div>
    </div>
  )
}
