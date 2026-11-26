import type { SubagentSummary, TranscriptItem } from '../../../shared/model'
import { groupAdvisoryItems, type AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'
import { groupMidTurnProse } from './groupMidTurnProse'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { groupThoughtItems } from './groupThoughtItems'
import { groupToolItems, type GroupedTranscriptItem } from './groupToolItems'

export interface TurnStageGrouping {
  groupedWithStages: AdvisoryGroupedTranscriptItem[]
  stages: StageGroup[]
}

interface Entry {
  showThinking: boolean
  /** The turn's items grouped up to, but not including, the Stage pass: independent of the readout summaries. */
  base: GroupedTranscriptItem[]
  hasSubagents: boolean
  summaries: readonly SubagentSummary[]
  result: TurnStageGrouping
}

// Keyed on the turn's items array. It hits only while that exact array is passed again: `reuseUnchangedTurns` keeps the previous
// array for a turn whose items are unchanged, so a streaming delta misses for the growing turn alone, not every turn above it.
const cache = new WeakMap<readonly TranscriptItem[], Entry>()

function stagePass(base: GroupedTranscriptItem[], summaries: readonly SubagentSummary[]): TurnStageGrouping {
  const groupedWithStages = groupMidTurnProse(groupAdvisoryItems(groupSubagentStages(base, summaries)))
  return { groupedWithStages, stages: groupedWithStages.filter(isStageGroup) }
}

/**
 * One turn's grouped rows. A readout-summaries update only matters to a turn that holds subagent items, so every other turn
 * keeps its previous result object, and a subagent turn redoes only the Stage pass onward.
 */
export function groupTurnStages(items: readonly TranscriptItem[], showThinking: boolean, summaries: readonly SubagentSummary[]): TurnStageGrouping {
  const hit = cache.get(items)
  if (hit && hit.showThinking === showThinking) {
    if (!hit.hasSubagents || hit.summaries === summaries) return hit.result
    const result = stagePass(hit.base, summaries)
    cache.set(items, { ...hit, summaries, result })
    return result
  }
  const viewItems: TranscriptItem[] = showThinking ? [...items] : items.filter((item) => item.kind !== 'thinking')
  const base = groupThoughtItems(groupToolItems(viewItems))
  const result = stagePass(base, summaries)
  cache.set(items, { showThinking, base, hasSubagents: base.some((item) => item.kind === 'subagent'), summaries, result })
  return result
}
