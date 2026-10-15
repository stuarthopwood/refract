// Split out of `Transcript.tsx` (file-size baseline, #563 remediation): the "Show tool calls"/
// "Show thinking" view-filter logic is a self-contained unit over `StageGroupedItem` that the
// render loop only ever calls, never inlines.
import type { TranscriptDisplaySettings } from '../../../shared/model'
import { isStageGroup } from './groupSubagentStages'
import type { StageGroupedItem } from './groupSubagentStages'
import { isToolGroup } from './groupToolItems'

// Bookkeeping rows (docs/DESIGN.md "Transcript rhythm", Stuart 2026-10-04): a run of these reads
// as compact, secondary material and must not inherit the full rhythm the turns/real messages
// around it use. Deliberately excludes an answered `ask` question (kind stays plain `tool`, never
// `tool-group` -- `groupToolItems` never merges `ask` calls) and a `request` card: both are a
// direct user<->assistant exchange, not bookkeeping, so DESIGN.md's own enumeration leaves them out.
const BOOKKEEPING_KINDS: Partial<Record<StageGroupedItem['kind'], true>> = {
  'tool-group': true,
  'stage-group': true,
  thinking: true,
  advisory: true,
  notice: true,
  'agent-message': true,
  'skill-prompt': true
}

export function isBookkeepingRow(row: StageGroupedItem): boolean {
  return BOOKKEEPING_KINDS[row.kind] === true
}

// Issue #457: two independent Settings-driven view filters. Neither toggle ever touches main's
// `HIDDEN_TOOLS` path, which drops an item before it ever becomes a transcript row at all -- these
// act as a pure *view* filter: turning one back on restores every hidden row immediately, including
// past turns, with no reload, since the underlying `TranscriptItem[]` in the transcript store is
// never touched. Filtering the array handed to `.map()` (the render loop in `Transcript.tsx`)
// rather than hiding rows with CSS is what keeps a fully-hidden row out of the accessibility tree
// and tab order entirely, and is also what makes a run of now-hidden rows leave no empty gap or
// stray margin: `isFirstRow`/`previousRow` (that render loop's own gap-class bookkeeping) only
// ever see the rows that are actually rendered with real content, so a hidden (or sr-only -- see
// below) row can never become the "previous" row a later one measures its own margin against.
//
// "Never hide what needs the user or reports a problem" (issue #457): an answered/pending `ask`
// question and a `request` card both survive untouched, since neither is a `ToolGroup` or a
// `StageGroup` to begin with (`groupToolItems` never merges an `ask` call, and `request`/
// `notice`/`advisory`/`agent-message` rows are never part of either filtered kind). A `ToolGroup`
// or `StageGroup` that reports a problem (an `error` or `interrupted` tool call; an `error`,
// `exited`, or `cancelled` subagent) stays `'visible'` even with "Show tool calls" off, matching
// `ChatDisplaySection.tsx`'s own copy ("failed or interrupted calls always show").
//
// Gate fix (H1/H4, #563 remediation round 4): EVERY hidden `thinking` item -- not only a
// non-streaming one -- is dropped from what actually renders; `Transcript.tsx`'s own
// `groupedForRender` does this AFTER grouping runs, not before (decision 3: Stage membership
// must never depend on a display setting). A thinking part's own `streaming` flag is the WHOLE
// assistant message's flag, so it can still read `true` while that message's later tool calls
// are already `running`; its own in-progress signal is announced once per message instead (see
// `Transcript.tsx`'s own `announceThinking`), outside the grouped rows entirely.
//
// Quality-gate fix (a11y, Medium, round 1): a `ToolGroup`/`StageGroup` row that is hidden by
// "Show tool calls" off but still ACTIVE right now (a `running` call) returns `'sr-only'` as a
// BASE candidate instead of `'hidden'` -- `Transcript.tsx`'s own render loop then promotes only
// the LAST such candidate in the turn (round 3: not simply the turn's last row by position -- a
// finished, hidden row can sit after the real running one, e.g. parallel subagents or a quick
// bookkeeping call that outraces a still-running sibling) back to `'sr-only'`, downgrading every
// earlier candidate to `'hidden'`. A group id is keyed off its first call, so a run of N
// sequential calls with tool calls hidden would otherwise unmount-and-remount a fresh `'sr-only'`
// row between every pair of calls, each one a new log addition and its own announcement, one per
// step instead of one per turn -- only while that row's own turn is actually running. A visible
// `'sr-only'` row swaps its content for a one-line sr-only status span naming what is running --
// the transcript's `role="log"` gets one polite addition marking a turn in progress, instead of a
// user whose screen reader has no visible `TurnTotalLine` text (`aria-hidden` while running)
// losing every sign of life. A row that finishes without needing attention naturally falls back
// to `'hidden'`.
export type RowVisibility = 'visible' | 'hidden' | 'sr-only'

export function rowVisibility(row: StageGroupedItem, transcriptDisplay: TranscriptDisplaySettings): RowVisibility {
  if (row.kind === 'thinking') return transcriptDisplay.thinking ? 'visible' : 'hidden'
  if (transcriptDisplay.toolCalls) return 'visible'
  // Issue #563: Stage groups follow the lone-subagent rule below (cancelled counts as visible too).
  if (isStageGroup(row)) {
    if (row.items.some((item) => item.status === 'error' || item.status === 'exited' || item.status === 'cancelled')) return 'visible'
    return row.items.some((item) => item.status === 'running') ? 'sr-only' : 'hidden'
  }
  if (isToolGroup(row)) {
    if (row.items.some((item) => item.status === 'error' || item.status === 'interrupted')) return 'visible'
    return row.items.some((item) => item.status === 'running') ? 'sr-only' : 'hidden'
  }
  return 'visible'
}
