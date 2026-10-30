// Component-free leaf for the Stage/chain status math, split out to break an import cycle between
// `SubagentChainRow.tsx` and `ChainStageLine.tsx` (#1008).
import type { TranscriptItem } from '../../../shared/model'
import { chatRowStatus, summarizeSubagentStatuses, type SubagentRowStatus } from '../subagents/subagentStatus'
import { stageRollupText } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'

export type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

// `endedAt` is undefined unless every item has both `startedAt` and `durationMs`, so a member with no
// duration cannot understate the total.
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

// Exported so the Transcript.tsx settle announcer keys off the same "has this settled" logic as the icon.
export function overallStatus(counts: Record<SubagentRowStatus, number>): SubagentRowStatus {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0) return 'failed'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.exited > 0) return 'exited'
  if (counts.parked > 0) return 'parked'
  return 'finished'
}

// Both delegate to the shared `stageRollupText` (`stageMeta.ts`), so the Subagents panel reads the same wording (#941).
export function stageRunningSummary(counts: Record<SubagentRowStatus, number>, total: number): string {
  return stageRollupText(counts, total, true)
}

/** Settled roll-up text ("5 done", "4 done, 1 failed"); exported so the Transcript.tsx announcer matches the Stage header. */
export function stageSettleSummary(group: StageGroup): string {
  const counts = summarizeSubagentStatuses(group.items.map((item) => chatRowStatus(item.status)))
  return stageRollupText(counts, group.items.length, false)
}
