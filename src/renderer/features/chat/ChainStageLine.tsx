// Split out of `SubagentChainRow.tsx` (file-size baseline, #806 "no god files"): `ChainStageLine`
// (decision 8: one labelled `role="group"` per Stage in the chain's own expanded body) and its
// own `ChainAgentEntry` (decision 6: one compact icon/name/duration entry, a button opening the
// Subagent panel when the tracker still knows it) -- the two pieces of `SubagentChainRow`'s own
// per-turn summary that never need its own top-level state (`useStickyDisclosure`, the fade-in
// seen-set, the duration tick), unlike `SubagentChainRow`/`StageGroupRow` themselves. Imports the
// shared stage-summary helpers back from `SubagentChainRow.tsx` (a circular import between the
// two files, safe here: every imported binding is a hoisted `function`/`type` declaration, never
// evaluated at module-top-level on either side).
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { StageUsesLine } from './StageDependencies'
import { rowVisibility } from './transcriptRowVisibility'
import { jumpToStage } from './stageJump'
import { formatElapsed } from './formatElapsed'
import { stageHeading } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'
import { overallStatus, stageSettleSummary, stageRunningSummary, stageTimeRange, type SubagentItem } from './SubagentChainRow'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusIcon,
  subagentStatusTextClass,
  summarizeSubagentStatuses
} from '../subagents/subagentStatus'

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
export function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
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
  // Issue #941 grill item 3 (label); `speechHeading` is reused below for both the group's own
  // `aria-label` and the jump button's (issue #1008 gate round 1, item 6).
  const stageLabel = stageHeading(stage.stageIndex, stage.label)
  const speechHeading = stageHeading(stage.stageIndex, stage.label, true)
  // Issue #1008 gate round 1, item 1 (High): the jump button only renders while this Stage's own
  // row is genuinely `'visible'` (`transcriptRowVisibility.ts`) -- "Show tool calls" off can drop
  // a settled, problem-free Stage entirely, leaving no row for `jumpToStage` to find (see its
  // own jsdoc, `stageJump.ts`, for the defensive lookup there too).
  const transcriptDisplay = useSettingsStore((s) => s.settings.transcriptDisplay)
  const isStageRowVisible = rowVisibility(stage, transcriptDisplay) === 'visible'
  const colorClass = subagentStatusTextClass(counts)
  return (
    <div
      role="group"
      // Gate round 1 fix (item 6): the speech form swaps "·" for a comma so it is never read
      // aloud as a literal glyph.
      aria-label={`${speechHeading}, ${summaryText}${status === 'running' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 text-sm"
    >
      {isStageRowVisible ? (
        <button
          type="button"
          title={`Go to ${stageLabel}`}
          // Issue #1008 gate round 1 (item 3, Medium): cursor/underline affordance cues beyond
          // colour; `py-0.5` matches `ChainAgentEntry`'s own 28px button height above.
          className={cn(
            'min-w-0 max-w-full cursor-pointer truncate rounded px-1 -mx-1 py-0.5 font-medium hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            colorClass
          )}
          aria-label={`Go to ${speechHeading}`}
          onClick={() => jumpToStage(sessionId, stage.id)}
        >
          {stageLabel}
        </button>
      ) : (
        <span className={cn('min-w-0 max-w-full truncate font-medium', colorClass)} title={stageLabel}>
          {stageLabel}
        </span>
      )}
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
