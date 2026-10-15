// Subagent chain row and Stage group row (issue #563 decisions 1-8, 14-21): the per-turn summary
// of serial/parallel subagent batches. A Stage is the subagents started by one `task()` call, or
// by `task()` calls issued together with nothing else between them in the transcript
// (`groupSubagentStages.ts`). `StageGroupRow` renders one Stage in place, at its real position in
// the log; `SubagentChainRow` renders once per turn, at the end, only when the turn has two or
// more Stages. Both reuse the shared `SubagentStatusIcon`/`summarizeSubagentStatuses` (issue #563
// decision 14) and the shared `SpineList` connector (issue #565, steered in while building this).
import * as React from 'react'
import { BotIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReadoutStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'
import { SpineList } from './SpineList'
import { SubagentRow } from './ToolRow'
import { formatElapsed } from './formatElapsed'
import type { StageGroup } from './groupSubagentStages'
import { chatRowStatus, SubagentStatusIcon, summarizeSubagentStatuses, type SubagentRowStatus } from '../subagents/subagentStatus'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

function stageTimeRange(items: readonly SubagentItem[]): { startedAt?: number; endedAt?: number } {
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const item of items) {
    if (item.startedAt != null && (startedAt === undefined || item.startedAt < startedAt)) startedAt = item.startedAt
    const end = item.startedAt != null && item.durationMs != null ? item.startedAt + item.durationMs : undefined
    if (end != null && (endedAt === undefined || end > endedAt)) endedAt = end
  }
  return { startedAt, endedAt }
}

// "N running", "N failed", "N cancelled", "N exited" joined by commas, each only when non-zero
// (decisions 5/15): cancelled is always its own word, never folded into "failed".
function rollupPhrase(counts: Record<SubagentRowStatus, number>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

function overallStatus(counts: Record<SubagentRowStatus, number>): SubagentRowStatus {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0) return 'failed'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.exited > 0) return 'exited'
  return 'finished'
}

/** One Stage, rendered in place (decision 4): always the same component type whether it has one
 * agent or several (mirrors `ToolGroupRow`'s own solo path, `groupToolItems.ts`), so a Stage's
 * row never switches React element type as a second agent streams in. Renders IDENTICAL output
 * to today's bare `SubagentRow` (decision 1) only when this is the turn's one and only Stage AND
 * that Stage has exactly one agent; every other Stage -- including a solo-agent Stage inside a
 * multi-Stage turn -- gets its own "Stage N" header (decision 1: "a single stage is fully
 * summarised by its own group header"). */
export function StageGroupRow({ group }: { group: StageGroup }) {
  const statuses = group.items.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const rollup = rollupPhrase(counts)
  const summary = `${group.items.length} agent${group.items.length === 1 ? '' : 's'}${rollup ? `, ${rollup}` : ''}`

  // Decision 21: "one polite announcement per stage when it settles ... nothing while history
  // loads" -- the ref's initial value is this render's own `isRunning`, so a Stage that mounts
  // already-settled (reopened history) never announces; only a LIVE running-to-settled
  // transition does. Called unconditionally, before the solo early-return below, since hooks
  // can never run conditionally.
  const [announcement, setAnnouncement] = React.useState('')
  const wasRunningRef = React.useRef(isRunning)
  React.useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      setAnnouncement(`Stage ${group.stageIndex} of ${group.totalStages} finished, ${summary}`)
    }
    wasRunningRef.current = isRunning
  }, [isRunning, group.stageIndex, group.totalStages, summary])

  const solo = group.totalStages === 1 && group.items.length === 1
  if (solo) return <SubagentRow item={group.items[0]!} />

  const { startedAt, endedAt } = stageTimeRange(group.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined

  return (
    <>
      {/* Always mounted (never created together with its own text, which a screen reader
       * generally fails to announce), outside the `Collapsible` below -- Radix unmounts
       * collapsed content entirely, so an sr-only span living only inside it could never
       * announce a settle that happens while the row is collapsed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <CollapsedLine
        icon={<SubagentStatusIcon status={status} />}
        label={`Stage ${group.stageIndex}`}
        summary={summary}
        summaryWrap
        meta={durationMs != null ? <span className="tabular-nums">{formatElapsed(durationMs)}</span> : undefined}
        defaultOpen={isRunning || status === 'failed' || status === 'cancelled' || status === 'exited'}
      >
        {/* Decision 2: the accessible name adds the stage COUNT the visible label omits. */}
        <span className="sr-only">
          Stage {group.stageIndex} of {group.totalStages}, {summary}
        </span>
        <SpineList gap="member">
          {group.items.map((item) => (
            <li key={item.id}>
              <SubagentRow item={item} />
            </li>
          ))}
        </SpineList>
      </CollapsedLine>
    </>
  )
}

/** One compact agent entry inside the chain's expanded body (decision 6): icon, name, duration;
 * a button that opens the Subagent panel on this agent when the tracker still knows it (decision
 * 7), else plain text (decision 7: "unbuilt [here, no-longer-tracked] actions are hidden, not
 * disabled" -- `docs/design/patterns.md`). Correlated to the live `SubagentSummary` list by
 * `toolCallId`+`specIndex` (the two representations use unrelated id schemes, `model.ts`'s own
 * documented rule), never by `item.id` directly. */
function ChainAgentEntry({ item, sessionId }: { item: SubagentItem; sessionId: string | null }) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId]?.subagents ?? []) : []))
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  const status = chatRowStatus(item.status)
  const duration = item.durationMs != null ? formatElapsed(item.durationMs) : undefined
  const content = (
    <>
      <SubagentStatusIcon status={status} />
      <span className="min-w-0 truncate" title={item.name}>
        {item.name}
      </span>
      {duration && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{duration}</span>}
    </>
  )
  if (!match || !sessionId) {
    return <span className="inline-flex max-w-48 items-center gap-1 text-sm text-muted-foreground">{content}</span>
  }
  return (
    <button
      type="button"
      className="inline-flex max-w-48 items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={(event) =>
        openHostedPanel('subagents', sessionId, { selectSubagentId: match.id, opener: event.currentTarget })
      }
    >
      {content}
    </button>
  )
}

function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="shrink-0 font-medium">Stage {stage.stageIndex}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {stage.items.map((item) => (
          <ChainAgentEntry key={item.id} item={item} sessionId={sessionId} />
        ))}
      </div>
    </div>
  )
}

/** Decision 7: a ghost icon-only button opening the panel without selecting any one agent --
 * separate from each entry's own activation, so the disclosure chevron (expand/collapse this
 * row) is never overloaded with a second meaning. */
function ChainShowPanelButton({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Show subagents panel"
          onClick={(event) => openHostedPanel('subagents', sessionId, { opener: event.currentTarget })}
        >
          <BotIcon aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show subagents panel</TooltipContent>
    </Tooltip>
  )
}

/** The per-turn summary (decision 5), shown only for two or more Stages (FR-065) -- a single
 * Stage is already fully summarised by its own `StageGroupRow` in place. `mt-6` baked in here
 * (decision 5: "not a bookkeeping row"), the same turn-rhythm margin `TurnTotalLine` uses,
 * because this renders directly in the turn's own `React.Fragment` (like `TurnTotalLine`), not
 * inside a `MessageScrollerItem` keyed to any one `TranscriptItem`. */
export function SubagentChainRow({ stages, sessionId }: { stages: StageGroup[]; sessionId: string | null }) {
  if (stages.length < 2) return null

  const allItems = stages.flatMap((stage) => stage.items)
  const statuses = allItems.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const { startedAt, endedAt } = stageTimeRange(allItems)
  // Decision 19: the chain's own duration ticks every second while running (measured wall-clock
  // from the first Stage's first start to now), and is `aria-hidden` while running (matches
  // `TurnTotalLine`'s own rule) so a screen reader only reads the final value once settled.
  const durationMs = startedAt == null ? undefined : isRunning ? Date.now() - startedAt : endedAt != null ? endedAt - startedAt : undefined
  const rollup = rollupPhrase(counts)
  const summary = `${stages.length} stages, ${allItems.length} agent${allItems.length === 1 ? '' : 's'}${rollup ? `, ${rollup}` : ''}`
  // Decision 6: expanded while anything is unsettled, collapsed once every agent finished --
  // covering a reopened history the same way.
  const defaultOpen = counts.running > 0 || counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0

  return (
    <CollapsedLine
      icon={<SubagentStatusIcon status={status} />}
      label="Subagents"
      summary={summary}
      summaryWrap
      meta={
        durationMs != null ? (
          <span aria-hidden={isRunning || undefined}>
            <span aria-hidden="true" className="tabular-nums">
              {formatElapsed(durationMs)}
            </span>
            <span className="sr-only">Took {formatElapsed(durationMs)}</span>
          </span>
        ) : undefined
      }
      defaultOpen={defaultOpen}
      className="mt-6"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="sr-only">{summary}</span>
        <ChainShowPanelButton sessionId={sessionId} />
      </div>
      <SpineList gap="stage">
        {stages.map((stage) => (
          <li key={stage.id}>
            <ChainStageLine stage={stage} sessionId={sessionId} />
          </li>
        ))}
      </SpineList>
    </CollapsedLine>
  )
}
