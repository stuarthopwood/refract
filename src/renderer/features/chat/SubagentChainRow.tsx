// Subagent chain row and Stage group row (issue #563 decisions 1-8, 14-21): the per-turn summary
// of serial/parallel subagent batches. A Stage is a maximal run of `subagent` items that share
// the same owning assistant message (`messageId`, gate round 2 architect addendum A) AND have
// nothing else between them in the transcript except a hidden-bookkeeping-tool failure notice
// (gate round 3, architect M5/M6: this combined rule, stated once here, is the single source of
// truth every other doc location points back to -- see `groupSubagentStages.ts` for the actual
// grouping code). `StageGroupRow` renders one Stage in place, at its real position in the log;
// `SubagentChainRow` renders once per turn, at the end, only when the turn has two or more
// Stages. Both reuse the shared `SubagentStatusIcon`/`summarizeSubagentStatuses` (issue #563
// decision 14) and the shared `SpineList` connector (issue #565, steered in while building this).
import * as React from 'react'
import { BotIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { StageContextBrief } from './StageContextBrief'
import { StageUsesLine } from './StageDependencies'
import { SubagentBody, SubagentRow } from './ToolRow'
import { formatElapsed } from './formatElapsed'
import { stageHeading, extractContextLabel } from './stageMeta'
import { joinMetaParts } from './toolRowLabels'
import type { StageGroup } from './groupSubagentStages'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph,
  SubagentStatusIcon,
  summarizeSubagentStatuses,
  type SubagentRowStatus
} from '../subagents/subagentStatus'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

// Gate round 3 fix (architect M1): `endedAt` used to be the max over only whichever items
// happened to report BOTH `startedAt` and `durationMs`, silently skipping any settled member
// missing one -- a cancelled/exited member with no recorded duration made the Stage/chain total
// understated instead of absent. Now `endedAt` is `undefined` unless EVERY item has both fields;
// `startedAt` is unaffected (still needed by the live running tick, which only ever needs it).
function stageTimeRange(items: readonly SubagentItem[]): { startedAt?: number; endedAt?: number } {
  let startedAt: number | undefined
  let maxEnd: number | undefined
  let everyItemSettled = true
  for (const item of items) {
    if (item.startedAt != null && (startedAt === undefined || item.startedAt < startedAt)) startedAt = item.startedAt
    if (item.startedAt == null || item.durationMs == null) {
      everyItemSettled = false
      continue
    }
    const end = item.startedAt + item.durationMs
    if (maxEnd === undefined || end > maxEnd) maxEnd = end
  }
  return { startedAt, endedAt: everyItemSettled ? maxEnd : undefined }
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

// Stage header roll-up wording (issue #941 grill item 3, gate round 1 fix: "N done"/"N done, M
// failed", not "N of M finished" -- while running, the live form states how many have settled
// so far against the total ("N of M done"), with any non-zero failed/cancelled/exited appended
// (comma-joined, same shape as `rollupPhrase`).
function stageRunningSummary(counts: Record<SubagentRowStatus, number>, total: number): string {
  const parts = [`${counts.finished} of ${total} done`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

/** The settled-form roll-up text (issue #941 grill item 3, gate round 1 fix): always leads with
 * "N done" (never a bare agent count), appending any non-zero failed/cancelled/exited --
 * "5 done" when every agent finished, "4 done, 1 failed" for a mixed outcome. Exported: the
 * Transcript.tsx settle announcer (a sibling slice) reads this exact text, so its live-region
 * announcement can never drift from what the Stage's own header already shows. */
export function stageSettleSummary(group: StageGroup): string {
  const counts = summarizeSubagentStatuses(group.items.map((item) => chatRowStatus(item.status)))
  const parts: string[] = [`${counts.finished} done`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

/** One Stage, rendered in place (decision 4): ALWAYS the same `CollapsedLine` (mirrors
 * `ToolGroupRow`'s own solo path, `groupToolItems.ts`), so a Stage's row never switches React
 * element type as a second agent streams in. Gate round 1 fix (issue #941, FR-079): a one-agent
 * Stage is NO LONGER a special case that renders identically to a bare `SubagentRow` (the
 * earlier #563 "a single agent renders exactly like today's SubagentRow" rule, gate round 2
 * architect addendum B, is superseded) -- every Stage, solo or not, shows the same name/green/
 * details/"Uses:" header; the only remaining difference is the body (`SubagentBody` directly
 * for one agent, a member `SpineList` for more than one, #565 decision 13: a list mounts only
 * once a 2nd member arrives). */
export function StageGroupRow({ group, sessionId }: { group: StageGroup; sessionId: string | null }) {
  const statuses = group.items.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const total = group.items.length
  // Issue #941 grill item 2: a finished agent or Stage gets green icon AND text (the one
  // exception to "done is neutral" -- tool rows/groups are untouched, `toolStatus.tsx`'s own
  // module). The icon already gets its colour from `STATUS_GLYPH` via `SubagentStatusGlyph`;
  // this is the matching text-colour half, applied to the label below.
  const successLabelClass = isSubagentSuccessStatus(status) ? SUBAGENT_SUCCESS_TEXT_CLASS : undefined

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

  const { startedAt, endedAt } = stageTimeRange(group.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const summaryText = isRunning ? stageRunningSummary(counts, total) : stageSettleSummary(group)
  const startTimeText =
    startedAt != null ? new Date(startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : undefined
  // Gate round 2 fix (item 1): a SOLO Stage with a captured `context` still shows the context
  // label as its header (unchanged); its one agent's own name, no longer stated anywhere once
  // `summary` moved into `meta` in round 1, comes back here specifically for this one case, as
  // `CollapsedLine`'s own `summary` slot (round 1's "counts moved out of summary" fix only ever
  // concerned the roll-up counts, not this). A solo Stage with NO context already gets the
  // agent's name AS its label (`stageMeta.ts`'s own `computeStageLabel` fix), so showing it a
  // second time here would be redundant -- gated on the context tier genuinely having produced
  // the label, not merely on `total === 1`.
  const soloContextLabel = total === 1 && group.context ? extractContextLabel(group.context) : null
  const soloAgentName = soloContextLabel ? group.items[0]!.name : undefined
  // Gate round 2 fix (item 5), gate round 3 fix: `joinMetaParts` (the shared `· `/sr-only-comma
  // separator every other meta slot in this codebase already uses) covers the ALWAYS-shown
  // core (the roll-up counts, then duration) -- the status word (shown only while running) and
  // the start time are each a separate, individually narrow-hideable unit instead, the
  // separator bundled INSIDE the same hideable span as its own content (gate round 3 fix:
  // `joinMetaParts` renders a part's own separator as a SEPARATE sibling before it, so hiding
  // only the content left a dangling "·" with nothing after it at a narrow width) -- hidden
  // together below `@max-[32rem]` (a container query against the chat pane's own
  // `[container-type:size]` ancestor, #554's same mechanism) so the Stage's own label -- never
  // this -- is what gives up space first; the settled "N done"/"N done, M failed" wording
  // already states failed/cancelled/exited, so a bare status word is shown only while running.
  const meta = (
    // Gate round 5 fix (issue #941, item 2, HIGH): `shrink-0` -> `min-w-0 shrink` -- this slot
    // never gave up width at 240-319px, forcing the label/chevron to absorb the whole squeeze.
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 whitespace-nowrap text-xs leading-5 text-muted-foreground">
      {joinMetaParts([<span key="summary" className="min-w-0 truncate" title={summaryText}>{summaryText}</span>])}
      {durationMs != null && (
        // Gate round 4 fix (issue #941, P5, MEDIUM): previously inside the `joinMetaParts`
        // array above (`shrink-0`, no hide rule at all), so a multi-agent Stage's own meta slot
        // could never give up the duration's own width under real pressure. Pulled out into
        // the SAME standalone, separator-bundled wrapper pattern `isRunning`/`startTimeText`
        // already use below (gate round 3 fix: `joinMetaParts` renders a part's own separator
        // as a SEPARATE sibling before it, so hiding only the content would leave a dangling
        // "·" with nothing after it at a narrow width) -- hidden together with them, one step
        // earlier (`@max-[20rem]`, narrower than their own `@max-[32rem]`), so the duration is
        // the LAST of the three optional parts to give up space, not the first.
        <span className="@max-[20rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
      {isRunning && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {startTimeText != null && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{`started ${startTimeText}`}</span>
        </span>
      )}
    </span>
  )
  const stageLabel = stageHeading(group.stageIndex, group.label)
  // Gate round 2 fix (item 8): no repeated "Stage N" -- `stageHeading`'s own speech form already
  // states it once ("Stage 3, label"), so the stage-count clause here is just "of M", not a
  // second "stage N of M". Gate round 1's item 1 fix (the name in the accessible name) applies
  // here too: `soloAgentName` is appended when present.
  const triggerAriaLabel = `${stageHeading(group.stageIndex, group.label, true)}, of ${group.totalStages}${soloAgentName ? `, ${soloAgentName}` : ''}, ${summaryText}${isRunning ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}${startTimeText != null ? `, started ${startTimeText}` : ''}`
  // Gate round 2 fix (item 4): the label-column indent (`pl-8 pr-2`) is passed to the brief/
  // Uses line explicitly -- a one-agent Stage's `CollapsibleContent` already carries `pl-8` via
  // its own `contentClassName` below, so they take `pr-2` alone there (no second `pl-8` on top
  // of the one the parent already applies); a multi-agent Stage's own `ml-4 pt-1` supplies no
  // indent at all, so they take the full `pl-8 pr-2` themselves.
  const columnClassName = total > 1 ? cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2') : 'pr-2'

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label={stageLabel}
      // Gate round 5 fix (issue #941, item 1, HIGH): `min-w-16` lives HERE now, not in
      // `CollapsedLine`'s own shared base class -- every other caller (tool rows, advisory
      // rows, notices) shares that same label span and was silently widened by a floor only
      // this Stage row needed.
      labelClassName={cn('min-w-16', successLabelClass)}
      summary={soloAgentName}
      summaryFixedWidth={soloAgentName !== undefined}
      meta={meta}
      // Gate round 6 fix (issue #941, item 1, MEDIUM): `min-w-0 shrink` lives HERE now, not in
      // `CollapsedLine`'s own shared `meta` base (restored to `shrink-0`) -- every other caller
      // (tool rows, advisory rows, request cards) shares that same wrapper and was silently
      // affected by the gate-round-5 fix meant only for this row.
      metaClassName="min-w-0 shrink"
      // Gate round 2 fix (item 1): a solo Stage never auto-expands (the architect M9 rule round
      // 1 accidentally dropped by unifying the two paths) -- FR-067's "renders collapsed by
      // default" stays true for the one-agent case specifically; a multi-agent Stage keeps its
      // existing running/failed/cancelled/exited auto-open.
      defaultOpen={total > 1 && (isRunning || status === 'failed' || status === 'cancelled' || status === 'exited')}
      triggerAriaLabel={triggerAriaLabel}
      // #565 decision 8: a multi-agent Stage's own `SpineList` needs its `ml-4`/`pt-1`; a
      // one-agent Stage's single `SubagentBody` instead starts at the ordinary label column
      // (#565 decisions 10/13) every other Spine member's own body does.
      contentClassName={total > 1 ? SPINE_HOST_CONTENT_CLASS : LABEL_COLUMN_CONTENT_CLASS}
    >
      {/* Gate round 3 fix (item 6): a tighter `space-y-1` for this group specifically, instead
          of `CollapsibleContent`'s own ambient `space-y-2` (which still governs spacing against
          any OTHER top-level content a future caller might add alongside these three). */}
      <div className="space-y-1">
        {/* Issue #941 grill item 4: the Stage's own full batch context, rendered Markdown, with
            a real expand/collapse control past about 6 lines (`StageContextBrief`); absent when
            no item in the run captured a `context` (a flat call, or history from before #941). */}
        {group.context && <StageContextBrief id={`${group.id}-context`} context={group.context} className={columnClassName} />}
        <StageUsesLine dependencies={group.dependencies} sessionId={sessionId} className={columnClassName} />
        {total > 1 ? (
          <SpineList gap="member">
            {group.items.map((item) => (
              <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
                <SubagentRow item={item} />
              </SpineItem>
            ))}
          </SpineList>
        ) : (
          <SubagentBody item={group.items[0]!} />
        )}
      </div>
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
  // uses for exactly this (e.g. `SubagentPanel.tsx`). Gate round 4 fix (issue #941, P7, LOW):
  // the OUTER `sessionId ? ... : []` branch still had its own fresh-literal fallback below this
  // comment was originally written to describe fixing -- both branches now resolve to the same
  // stable `EMPTY_READOUT_ENTRY.subagents` reference.
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
  // Issue #941 grill item 4 (gate round 1 fix): the chain's own terse one-line-per-stage summary
  // also states the Stage's own duration.
  const { startedAt, endedAt } = stageTimeRange(stage.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  // Issue #941 grill item 3: the same three-tier Stage label `StageGroupRow` shows, here on the
  // chain's own terse one-line-per-stage summary.
  const stageLabel = stageHeading(stage.stageIndex, stage.label)
  return (
    <div
      role="group"
      // Gate round 1 fix (item 6): the speech form swaps "·" for a comma so it is never read
      // aloud as a literal glyph.
      aria-label={`${stageHeading(stage.stageIndex, stage.label, true)}, ${summaryText}${status === 'running' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 text-sm"
    >
      <span
        className={cn('min-w-0 max-w-full truncate font-medium', isSubagentSuccessStatus(status) && SUBAGENT_SUCCESS_TEXT_CLASS)}
        title={stageLabel}
      >
        {stageLabel}
      </span>
      {durationMs != null && (
        <span aria-hidden="true" className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {formatElapsed(durationMs)}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {stage.items.map((item) => (
          <ChainAgentEntry key={item.id} item={item} sessionId={sessionId} />
        ))}
      </div>
      <StageUsesLine dependencies={stage.dependencies} sessionId={sessionId} className="basis-full" />
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

  // Gate-fix (live build, first real build-slot run -- never exercised before now):
  // `defaultOpen` below only mattered to `CollapsedLine`'s own `useState(defaultOpen ?? false)`
  // AT THE INSTANT this component first mounts. If this chain row mounts (`stages.length` first
  // reaches 2) while every agent so far is still genuinely pending/finished -- entirely
  // plausible: Stage 5's own failure may not exist yet -- that initializer captures `false` once
  // and never re-reads a LATER `defaultOpen` recompute, so a Stage that fails well after this
  // row's first mount could never auto-open it (confirmed live: this fixture's own Stage 5
  // failure left the chain row closed on first render instead of Decision 6's "expanded while
  // anything is unsettled"). Fixed by going fully controlled here and re-syncing `open` to the
  // live unsettled condition whenever it changes, UNTIL the user explicitly toggles it
  // (`userToggledRef`) -- an explicit collapse/expand always wins from that point on, matching
  // ordinary disclosure-widget expectations, while an untouched row keeps tracking "anything
  // unsettled" dynamically instead of freezing at whatever was true the first time this
  // component happened to mount. Hooks run unconditionally, ahead of the `stages.length < 2`
  // early return below.
  const isUnsettled = counts.running > 0 || counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  const userToggledRef = React.useRef(false)
  const [open, setOpen] = React.useState(isUnsettled)
  React.useEffect(() => {
    if (userToggledRef.current) return
    setOpen(isUnsettled)
  }, [isUnsettled])

  if (stages.length < 2) return null

  const { startedAt, endedAt } = stageTimeRange(allItems)
  // Decision 19: the chain's own duration ticks every second while running (measured wall-clock
  // from the first Stage's first start to now), and is `aria-hidden` while running (matches
  // `TurnTotalLine`'s own rule) so a screen reader only reads the final value once settled.
  const durationMs = startedAt == null ? undefined : isRunning ? Date.now() - startedAt : endedAt != null ? endedAt - startedAt : undefined
  const rollup = rollupPhrase(counts)
  const summary = `${stages.length} stages, ${allItems.length} agent${allItems.length === 1 ? '' : 's'}${rollup ? `, ${rollup}` : ''}`
  // #563 remediation (H1): `icon=` is a `CollapsedLine` icon slot, so the status word stays
  // sr-only there (`SubagentStatusGlyph`) and is rendered visibly HERE instead, in `meta`, ahead
  // of the duration -- gated off for `finished` (decision 14). `aria-hidden` (gate round 2,
  // double-word fix): `triggerAriaLabel` below restates the word and duration once on its own,
  // so the formerly-separate `sr-only` "Took ..." span is dead now and dropped entirely.
  const statusVisible = status !== 'finished'
  const meta = (
    // Gate round 5 fix (issue #941, item 2, HIGH/MEDIUM): `shrink-0` -> `min-w-0 shrink` (same
    // 240-319px chevron-clip fix as the Stage row above); the status word and duration used to
    // run together with NO separator at all when both rendered ("Running1m 20s") -- a real "·"
    // now joins them, bundled inside the duration's own narrow-hideable span (so hiding the
    // duration at `@max-[20rem]` -- matching the Stage row's own threshold -- never leaves a
    // dangling leading "·" with nothing visible before it).
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      {statusVisible && (
        <span className="min-w-0 truncate" title={SUBAGENT_STATUS_LABEL[status]}>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {durationMs != null && (
        // Gate round 6 fix (issue #941, item 2, LOW): `whitespace-nowrap` on the duration span
        // -- `tabular-nums` alone does not stop "1m 20s" itself wrapping across two lines once
        // this now-shrinkable slot runs short of room.
        <span className="@max-[20rem]:hidden whitespace-nowrap">
          {statusVisible && <span> · </span>}
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
    </span>
  )

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label="Subagents"
      summary={summary}
      summaryWrap
      meta={meta}
      // Gate round 6 fix (issue #941, item 1, MEDIUM): same opt-in as the Stage row above.
      metaClassName="min-w-0 shrink"
      open={open}
      onOpenChange={(next) => {
        userToggledRef.current = true
        setOpen(next)
      }}
      className="mt-6"
      contentClassName={SPINE_HOST_CONTENT_CLASS}
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
        {stages.map((stage) => (
          <SpineItem key={stage.id} isNew={!seenStageIds.has(stage.id) && isRunning}>
            <ChainStageLine stage={stage} sessionId={sessionId} />
          </SpineItem>
        ))}
      </SpineList>
    </CollapsedLine>
  )
}
