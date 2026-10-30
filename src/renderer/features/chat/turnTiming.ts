import { COMMAND_OUTPUT_NOTICE_PREFIX } from '../../../shared/commandOutputNotice'
import type { TranscriptItem } from '../../../shared/model'

// Split out of Transcript.tsx to stay within the 600-line file-size cap (scripts/check-file-
// size.mjs). Pure turn-timing helpers, no JSX or component state.

function itemEndTime(item: TranscriptItem): number | undefined {
  if (item.kind === 'tool' || item.kind === 'subagent') {
    return item.startedAt != null && item.durationMs != null ? item.startedAt + item.durationMs : undefined
  }
  if (item.kind === 'thinking') return item.endedAt
  if (item.kind === 'user' || item.kind === 'agent-message') return item.at
  return undefined
}

function countableItemEnd(item: TranscriptItem, receivedAt: Record<string, number>): number | undefined {
  if (item.kind === 'user') return undefined
  if (item.kind === 'notice' && item.id.startsWith(COMMAND_OUTPUT_NOTICE_PREFIX)) return undefined
  return receivedAt[item.id] ?? itemEndTime(item)
}

export function computeTurnEnd(turnItems: TranscriptItem[], receivedAt: Record<string, number>): number | undefined {
  let maxEnd: number | undefined
  for (const item of turnItems) {
    const end = countableItemEnd(item, receivedAt)
    if (end != null && (maxEnd === undefined || end > maxEnd)) maxEnd = end
  }
  return maxEnd
}

/** True when this turn has gained a real (non-`user`, non-command-output) item with an end time. */
export function hasNewerRealActivity(turnItems: TranscriptItem[], receivedAt: Record<string, number>, settledEnd: number): boolean {
  return turnItems.some((item) => {
    const end = countableItemEnd(item, receivedAt)
    return end != null && end > settledEnd
  })
}
