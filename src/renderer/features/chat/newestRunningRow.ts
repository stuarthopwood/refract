// Picks the one transcript row whose label shimmers (#1210, spec 040 FR-005): the NEWEST row that
// is still running, decided once per turn here rather than per row so exactly one row ever has it.
// It moves to the next running row as the current one finishes, and there is none once the turn
// has ended (the caller passes no rows for a finished turn).
import { isAgentSteerGroup, isToolGroup, isThoughtRun } from './groupToolItems'
import { isStageGroup } from './groupSubagentStages'
import type { AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'

function isRunningRow(row: AdvisoryGroupedTranscriptItem): boolean {
  if (isStageGroup(row) || (isToolGroup(row) && !isAgentSteerGroup(row))) return row.items.some((item) => item.status === 'running')
  if (isThoughtRun(row)) return row.items.some((item) => item.streaming)
  return false
}

export function newestRunningRowId(rows: readonly AdvisoryGroupedTranscriptItem[]): string | undefined {
  return rows.findLast(isRunningRow)?.id
}
