// Split out of `SubagentChainRow.tsx` (gate round 1, issue #1008, Main 2026-10-18): a pure,
// component-free leaf module for the Stage/chain status-summary math both `SubagentChainRow.tsx`
// and `ChainStageLine.tsx` need -- moved here specifically to break the circular import that
// existed between those two files (`ChainStageLine.tsx` importing these back from
// `SubagentChainRow.tsx`, which imports `ChainStageLine` from `ChainStageLine.tsx`). This module
// imports neither component file, so there is nothing left to cycle.
import type { TranscriptItem } from '../../../shared/model'
import { chatRowStatus, summarizeSubagentStatuses, type SubagentRowStatus } from '../subagents/subagentStatus'
import { stageRollupText } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'

export type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

// Gate round 3 fix (architect M1): `endedAt` used to be the max over only whichever items
// happened to report BOTH `startedAt` and `durationMs`, silently skipping any settled member
// missing one -- a cancelled/exited member with no recorded duration made the Stage/chain total
// understated instead of absent. Now `endedAt` is `undefined` unless EVERY item has both fields;
// `startedAt` is unaffected (still needed by the live running tick, which only ever needs it).
export function stageTimeRange(items: readonly SubagentItem[]): { startedAt?: number; endedAt?: number } {
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
// (comma-joined, same shape as `rollupPhrase`, `SubagentChainRow.tsx`). Gate round 1 fix (issue
// #941 part 2, item 6): both delegate to the shared `stageRollupText` (`stageMeta.ts`), reused
// verbatim by the Subagents panel's own Stage header so the two surfaces can never read this
// wording differently.
export function stageRunningSummary(counts: Record<SubagentRowStatus, number>, total: number): string {
  return stageRollupText(counts, total, true)
}

/** The settled-form roll-up text (issue #941 grill item 3, gate round 1 fix): always leads with
 * "N done" (never a bare agent count), appending any non-zero failed/cancelled/exited --
 * "5 done" when every agent finished, "4 done, 1 failed" for a mixed outcome. Exported: the
 * Transcript.tsx settle announcer (a sibling slice) reads this exact text, so its live-region
 * announcement can never drift from what the Stage's own header already shows. */
export function stageSettleSummary(group: StageGroup): string {
  const counts = summarizeSubagentStatuses(group.items.map((item) => chatRowStatus(item.status)))
  return stageRollupText(counts, group.items.length, false)
}
