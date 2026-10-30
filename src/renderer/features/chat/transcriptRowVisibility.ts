import type { TranscriptDisplaySettings } from '../../../shared/model'
import { isStageGroup } from './groupSubagentStages'
import { isAgentSteerGroup, isToolGroup } from './groupToolItems'
import type { AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'

// Bookkeeping rows read as compact secondary material and must not inherit the turn rhythm.
const BOOKKEEPING_KINDS: Partial<Record<AdvisoryGroupedTranscriptItem['kind'], true>> = {
  'tool-group': true,
  'stage-group': true,
  'thought-run': true,
  'advisory-run': true,
  advisory: true,
  notice: true,
  'agent-message': true,
  'skill-prompt': true,
  // #1300: a Note row matches the other rows at the chosen density instead of taking `mt-6`.
  'mid-turn-prose': true
}

export function isBookkeepingRow(row: AdvisoryGroupedTranscriptItem): boolean {
  if (row.kind === 'request') return row.resolved !== undefined
  if (row.kind === 'tool') return row.tool === 'ask' && row.status !== 'running'
  return BOOKKEEPING_KINDS[row.kind] === true
}
export type RowVisibility = 'visible' | 'hidden' | 'sr-only'

export function rowVisibility(row: AdvisoryGroupedTranscriptItem, transcriptDisplay: TranscriptDisplaySettings): RowVisibility {
  if (row.kind === 'thought-run') return transcriptDisplay.thinking ? 'visible' : 'hidden'
  if (row.kind === 'advisory-run') return 'visible'
  if (transcriptDisplay.toolCalls) return 'visible'
  // #838: a steering write renders as an agent-to-agent line, which "Show tool calls" never hides.
  if (isAgentSteerGroup(row)) return 'visible'
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
