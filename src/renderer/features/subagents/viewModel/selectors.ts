import type { SubagentSummary, TranscriptItem } from '../../../../shared/model'
import { fromSummaries } from './fromSummaries'
import type { TranscriptSubagentItem } from './runs'
import type { ChatScenario } from './types'

/** The scenario for no agents; one shared object so an empty readout never re-renders a subscriber. */
export const EMPTY_SCENARIO: ChatScenario = Object.freeze(fromSummaries([])) as ChatScenario

export const NO_SUBAGENT_ITEMS: readonly TranscriptSubagentItem[] = Object.freeze([])

/** The transcript's subagent items. Pair with a shallow-equal subscription: the array is new each call, its items are not. */
export function selectSubagentItems(items: readonly TranscriptItem[]): TranscriptSubagentItem[] {
  return items.filter((item): item is TranscriptSubagentItem => item.kind === 'subagent')
}

const summariesCache = new WeakMap<readonly SubagentSummary[], { items: readonly TranscriptSubagentItem[]; scenario: ChatScenario }>()

/**
 * The panel's scenario, memoised on the identity of the readout's `subagents` array (a store update replaces it) and of the
 * transcript items that supply the text the summaries lack.
 */
export function selectScenarioFromSummaries(summaries: readonly SubagentSummary[], items: readonly TranscriptSubagentItem[] = NO_SUBAGENT_ITEMS): ChatScenario {
  if (summaries.length === 0) return EMPTY_SCENARIO
  const hit = summariesCache.get(summaries)
  if (hit && hit.items === items) return hit.scenario
  const scenario = fromSummaries(summaries, items)
  summariesCache.set(summaries, { items, scenario })
  return scenario
}
