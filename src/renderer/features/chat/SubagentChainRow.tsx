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
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'
import { SpineList } from './SpineList'
import { SubagentBody, SubagentRow } from './ToolRow'
import { formatElapsed } from './formatElapsed'
import type { StageGroup } from './groupSubagentStages'
import {
  chatRowStatus,
  SUBAGENT_STATUS_LABEL,
  SubagentStatusGlyph,
  SubagentStatusIcon,
  summarizeSubagentStatuses,
  type SubagentRowStatus
} from '../subagents/subagentStatus'

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
// (decisions 5/15): cancelled is always its own word, never folded into "failed". Used by
// `SubagentChainRow`'s own per-turn roll-up; `StageGroupRow`'s own roll-up (below) needs the
// "N of M finished" / mixed-outcome "finished" wording decision 5/M1 asks for instead.
function rollupPhrase(counts: Record<SubagentRowStatus, number>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

// Exported: the Transcript.tsx settle announcer (a sibling slice, #563 remediation H3) needs the
// same overall-status classification a Stage/chain header already uses, so its one centralised
// announcement is keyed off the exact same "has this settled" logic as the visible icon.
export function overallStatus(counts: Record<SubagentRowStatus, number>): SubagentRowStatus {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0) return 'failed'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.exited > 0) return 'exited'
  return 'finished'
}

// Stage header roll-up wording (#563 remediation, M1/M2): while running, "N agents, N running"
// muddied the one fact that matters -- how many have actually finished -- so the live form reads
// "N of M finished" instead, with any non-zero failed/cancelled/exited appended (comma-joined,
// same shape as `rollupPhrase`).
function stageRunningSummary(counts: Record<SubagentRowStatus, number>, total: number): string {
  const parts = [`${counts.finished} of ${total} finished`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

/** The settled-form "N agents, rollup" text (#563 remediation, M1/M2): the "N agents" form
 * returns once settled, but a MIXED outcome (not every agent merely finished) also states how
 * many did, so "4 agents, 3 finished, 1 failed" never hides a partial result behind a flat count
 * -- a Stage where every agent finished stays the plain, quiet "N agents" decision 14 intends.
 * Exported: the Transcript.tsx settle announcer (a sibling slice) reads these exact words, so its
 * live-region announcement can never drift from the text the Stage's own header already shows. */
export function stageSettleSummary(group: StageGroup): string {
  const counts = summarizeSubagentStatuses(group.items.map((item) => chatRowStatus(item.status)))
  const total = group.items.length
  const categories = [counts.finished, counts.failed, counts.cancelled, counts.exited].filter((n) => n > 0).length
  const parts: string[] = []
  if (categories > 1 && counts.finished > 0) parts.push(`${counts.finished} finished`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return `${total} agent${total === 1 ? '' : 's'}${parts.length ? `, ${parts.join(', ')}` : ''}`
}

/** One Stage, rendered in place (decision 4): ALWAYS the same `CollapsedLine` (mirrors
 * `ToolGroupRow`'s own solo path, `groupToolItems.ts`), so a Stage's row never switches React
 * element type as a second agent or a second Stage streams in (#563 remediation H2/H3: the
 * previous `solo` branch returned a bare `SubagentRow` -- a different element type -- unmounting
 * and losing open/focus state the instant a second agent or Stage arrived). A Stage with exactly
 * one agent renders IDENTICAL output to today's bare `SubagentRow` (decision 1: "a single agent
 * renders exactly like today's SubagentRow") whether or not the turn has other Stages (gate
 * round 2 architect addendum B: `solo` is `items.length === 1` in every turn, never gated on
 * `totalStages` too -- the Stage number lives ONLY in the chain and in this row's own
 * `triggerAriaLabel`, never in the visible label, so nothing is relabelled under the reader when
 * a second Stage later arrives, decision 6). Every multi-agent Stage gets its own "Stage N"
 * header (decision 1: "a single stage is fully summarised by its own group header"); its content
 * is the member `SpineList` (a one-agent Stage's content is the agent's own body directly, no
 * `SpineList`/`<ol>` at all -- #565 decision 13: a list mounts only once a 2nd member arrives). */
export function StageGroupRow({ group }: { group: StageGroup }) {
  const statuses = group.items.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const total = group.items.length
  const solo = total === 1

  // #563 remediation (L4/decision 19, #565 decision 26) fade-in: a member row that mounts WHILE
  // this Stage is live (running) fades in; one present at a settled/history mount never does.
  // Seeded synchronously during render (never in an effect, so a settled reopen never flashes a
  // first invisible frame), then every currently-rendered id is marked seen in an effect after
  // paint so a row only ever fades in once.
  const seenIdsRef = React.useRef<Set<string> | null>(null)
  if (seenIdsRef.current === null) {
    const seen = new Set<string>()
    if (!isRunning) for (const item of group.items) seen.add(item.id)
    seenIdsRef.current = seen
  }
  const seenIds = seenIdsRef.current
  React.useEffect(() => {
    for (const item of group.items) seenIds.add(item.id)
  }, [group.items, seenIds])

  if (solo) {
    const item = group.items[0]!
    const duration =
      item.status !== 'running' && item.durationMs != null ? formatElapsed(item.durationMs) : undefined
    // #563 gate round 2 (double-word fix): the visible word here duplicates the icon slot's own
    // `SubagentStatusGlyph` `sr-only` word (both sit inside this trigger's accessible name), and
    // `triggerAriaLabel` below already states the word and duration once on its own -- `aria-
    // hidden` keeps this span sighted-only, so the computed name is never read twice.
    const meta = (
      <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {status !== 'finished' && SUBAGENT_STATUS_LABEL[status]}
        {duration != null && <span className="tabular-nums">{duration}</span>}
      </span>
    )
    return (
      <CollapsedLine
        icon={<SubagentStatusGlyph status={status} />}
        label={item.name}
        meta={meta}
        // Gate round 3 fix (architect M9): a Stage that mounts with exactly one agent and later
        // gains a sibling (becoming a multi-agent Stage) stays inside the SAME uncontrolled
        // `CollapsedLine` the whole time (Radix only reads `defaultOpen` on mount) -- without this,
        // it stayed collapsed through that transition while still running (decision 6 requires
        // expanded while unsettled). Matches the non-solo branch's own `defaultOpen` below exactly.
        defaultOpen={isRunning || status === 'failed' || status === 'cancelled' || status === 'exited'}
        // Gate round 2 addendum B: "Stage N of M" lives ONLY in the accessible name, not the
        // visible label, so a solo Stage still reads identically to today's bare `SubagentRow`.
        triggerAriaLabel={`Stage ${group.stageIndex} of ${group.totalStages}, ${item.name}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${duration != null ? `, ${duration}` : ''}`}
        className="border-transparent hover:border-transparent"
      >
        <SubagentBody item={item} />
      </CollapsedLine>
    )
  }

  const { startedAt, endedAt } = stageTimeRange(group.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const summaryText = isRunning ? stageRunningSummary(counts, total) : stageSettleSummary(group)
  // #563 remediation (H1): `icon=` is a `CollapsedLine` icon slot, so the status word stays
  // sr-only there (`SubagentStatusGlyph`) and is rendered visibly HERE instead, in `meta`, ahead
  // of the duration -- gated off for `finished` (decision 14). `aria-hidden` (gate round 2,
  // double-word fix): `triggerAriaLabel` below restates the word and duration once on its own.
  const meta = (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {status !== 'finished' && SUBAGENT_STATUS_LABEL[status]}
      {durationMs != null && <span className="tabular-nums">{formatElapsed(durationMs)}</span>}
    </span>
  )

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label={`Stage ${group.stageIndex}`}
      // M1/L2: label and summary joined with a literal "· " separator, aria-hidden on the dot
      // only -- the accessible name comes entirely from `triggerAriaLabel` below instead.
      summary={
        <>
          <span aria-hidden="true">· </span>
          {summaryText}
        </>
      }
      summaryWrap
      meta={meta}
      defaultOpen={isRunning || status === 'failed' || status === 'cancelled' || status === 'exited'}
      // M1/decision 2: the accessible name carries the stage COUNT the visible label omits,
      // applied directly to the trigger (not an sr-only span inside `children`, which Radix
      // unmounts while collapsed and so is invisible to assistive tech in the common case).
      // Gate round 2 (Low): also restates the running/failed/etc. word and duration `meta` shows
      // visibly, since `aria-label` replaces the content name outright -- otherwise a running
      // Stage's own accessible name carries no "Running" and no elapsed time at all.
      triggerAriaLabel={`Stage ${group.stageIndex} of ${group.totalStages}, ${summaryText}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      className="border-transparent hover:border-transparent"
      // #565 decision 8: the sole geometry in play once a `SpineList` is the content is its own
      // `ml-4`/`pt-1` -- `total` is always >= 2 here (a solo Stage returns early above).
      contentClassName="space-y-0 p-0"
    >
      <SpineList gap="member">
        {group.items.map((item) => {
          const isNew = isRunning && !seenIds.has(item.id)
          return (
            <li key={item.id} className={isNew ? 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150' : undefined}>
              <SubagentRow item={item} />
            </li>
          )
        })}
      </SpineList>
    </CollapsedLine>
  )
}

/** One compact agent entry inside the chain's expanded body (decision 6): icon, name, duration;
 * a button that opens the Subagent panel on this agent when the tracker still knows it (decision
 * 7), else plain text (decision 7: "unbuilt [here, no-longer-tracked] actions are hidden, not
 * disabled" -- `docs/design/patterns.md`). Correlated to the live `SubagentSummary` list by
 * `toolCallId`+`specIndex` (the two representations use unrelated id schemes, `model.ts`'s own
 * documented rule), never by `item.id` directly. */
function ChainAgentEntry({ item, sessionId }: { item: SubagentItem; sessionId: string | null }) {
  // Quality-gate remediation (Medium, code review): the bare `?? []` fallback returned a fresh
  // array identity on every render, defeating zustand's `useSyncExternalStore` memoisation under
  // React 19 -- `EMPTY_READOUT_ENTRY` is the stable singleton the rest of the codebase already
  // uses for exactly this (e.g. `SubagentPanel.tsx`).
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : []))
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
    return <span className="inline-flex max-w-48 items-center gap-1 px-2 py-1 text-sm text-muted-foreground">{content}</span>
  }
  return (
    <button
      type="button"
      className="inline-flex max-w-48 items-center gap-1 rounded px-2 py-1 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      onClick={(event) =>
        openHostedPanel('subagents', sessionId, { selectSubagentId: match.id, opener: event.currentTarget })
      }
    >
      {content}
    </button>
  )
}

// Decision 8: each Stage's own line in the chain body is a labelled `role="group"` -- the
// `<ol>`/`<li>` from `SpineList` only gives an unlabelled "1 of 2" position, which softens the
// stage boundary a screen reader needs to hear. `px-2` (gate round 2, High): `SpineList`'s own
// `pl-2` was dropped in favour of each ROW supplying its own 8px gap from the line (#565
// decision 8), which this row's text never did, leaving "Stage N" flush against the spine.
function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
  // Gate round 3 (Low): the label used `stageSettleSummary` unconditionally, hiding the running
  // state entirely while a Stage was still in flight ("Stage 1 of 2, 2 agents" instead of
  // stating that it's running) -- mirrors `StageGroupRow`'s own running-vs-settled summary split.
  const counts = summarizeSubagentStatuses(stage.items.map((item) => chatRowStatus(item.status)))
  const status = overallStatus(counts)
  const summaryText = status === 'running' ? stageRunningSummary(counts, stage.items.length) : stageSettleSummary(stage)
  return (
    <div
      role="group"
      aria-label={`Stage ${stage.stageIndex} of ${stage.totalStages}, ${summaryText}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}`}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 text-sm"
    >
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
 * row) is never overloaded with a second meaning. Lives in the chain header's own `action=` slot
 * (#563 remediation, M1/M4/M5): a sibling of the `CollapsibleTrigger`, not nested inside it. */
function ChainShowPanelButton({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null
  return (
    <Tooltip>
      {/* `aria-describedby={undefined}` (repo convention, e.g. `PanelTabBar.tsx`'s own
       * `TabButton`): Radix sets `aria-describedby` on the trigger whenever the tooltip is open,
       * and a screen reader's accessible-description computation follows that reference into the
       * tooltip's own text regardless -- redundant here since `aria-label` is already the full
       * description. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
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
  // Decision 19/#565 decision 26 fade-in: a Stage entry that mounts WHILE the chain is live
  // (running) fades in; one present at a settled/history mount never does (same seen-set
  // pattern as `StageGroupRow`'s own member rows, lazily seeded during render, never in an
  // effect, so a settled reopen never flashes a first invisible frame). Computed unconditionally,
  // before the `stages.length < 2` early return below, since hooks can never run conditionally.
  const seenStageIdsRef = React.useRef<Set<string> | null>(null)
  const allItems = stages.flatMap((stage) => stage.items)
  const statuses = allItems.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'

  if (seenStageIdsRef.current === null) {
    const seen = new Set<string>()
    if (!isRunning) for (const stage of stages) seen.add(stage.id)
    seenStageIdsRef.current = seen
  }
  const seenStageIds = seenStageIdsRef.current
  React.useEffect(() => {
    for (const stage of stages) seenStageIds.add(stage.id)
  }, [stages, seenStageIds])

  // Decision 19 (gate round 2 fix): the chain's own duration must genuinely tick once a second
  // while running, matching `Transcript.tsx`'s own `TurnTotalLine` tick (`forceTick` pattern) --
  // the comment below already claimed this, but nothing re-rendered this component on its own
  // until now, so `Date.now()` was only ever read once per OTHER state change. Also before the
  // early return (hooks rule). Gate round 3 (Low): also gated on `stages.length >= 2`, since a
  // running turn with fewer Stages renders `null` below and never needs to re-render on a tick.
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!isRunning || stages.length < 2) return
    const interval = setInterval(forceTick, 1000)
    return () => clearInterval(interval)
  }, [isRunning, stages.length])

  if (stages.length < 2) return null

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
  // #563 remediation (H1): `icon=` is a `CollapsedLine` icon slot, so the status word stays
  // sr-only there (`SubagentStatusGlyph`) and is rendered visibly HERE instead, in `meta`, ahead
  // of the duration -- gated off for `finished` (decision 14). `aria-hidden` (gate round 2,
  // double-word fix): `triggerAriaLabel` below restates the word and duration once on its own,
  // so the formerly-separate `sr-only` "Took ..." span is dead now and dropped entirely.
  const meta = (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {status !== 'finished' && SUBAGENT_STATUS_LABEL[status]}
      {durationMs != null && <span className="tabular-nums">{formatElapsed(durationMs)}</span>}
    </span>
  )

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label="Subagents"
      summary={summary}
      summaryWrap
      meta={meta}
      defaultOpen={defaultOpen}
      className="mt-6 border-transparent hover:border-transparent"
      contentClassName="space-y-0 p-0"
      // Gate round 2 (Low): also restates the running/failed/etc. word `meta` shows visibly,
      // since `aria-label` replaces the content name outright. Gate round 3 (Medium): the
      // duration is left OUT while running -- it ticks every second (`forceTick` above), and
      // restating a ticking value in the accessible name would change a focused trigger's own
      // name once a second (decision 19/21: the duration stays `aria-hidden` in `meta` and
      // nothing should be announced per tick); it is restated only once settled, the instant it
      // stops ticking.
      triggerAriaLabel={`Subagents, ${summary}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${!isRunning && durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      action={<ChainShowPanelButton sessionId={sessionId} />}
    >
      <SpineList gap="stage">
        {stages.map((stage) => {
          const isNew = !seenStageIds.has(stage.id) && isRunning
          return (
            <li
              key={stage.id}
              className={isNew ? 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150' : undefined}
            >
              <ChainStageLine stage={stage} sessionId={sessionId} />
            </li>
          )
        })}
      </SpineList>
    </CollapsedLine>
  )
}
