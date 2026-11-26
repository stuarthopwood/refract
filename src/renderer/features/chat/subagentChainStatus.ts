// Component-free leaf for the Stage/chain status math, split out to break an import cycle between
// `SubagentChainRow.tsx` and `ChainStageLine.tsx` (#1008).
import type { TranscriptItem } from '../../../shared/model'
import type { SubagentRowStatus } from '../subagents/subagentStatus'

export type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

// Exported so the Transcript.tsx settle announcer keys off the same "has this settled" logic as the icon.
export function overallStatus(counts: Record<SubagentRowStatus, number>): SubagentRowStatus {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0) return 'failed'
  if (counts.cancelled > 0) return 'cancelled'
  if (counts.exited > 0) return 'exited'
  if (counts.parked > 0) return 'parked'
  return 'finished'
}
