import type { SubagentSummary } from '../../../../shared/model'
import { fromSummaries } from './fromSummaries'
import type { ChatScenario } from './types'

/** The scenario for no agents; one shared object so an empty readout never re-renders a subscriber. */
export const EMPTY_SCENARIO: ChatScenario = Object.freeze(fromSummaries([])) as ChatScenario

const summariesCache = new WeakMap<readonly SubagentSummary[], ChatScenario>()

/** The panel's scenario, memoised on the identity of the readout's `subagents` array (a store update replaces it). */
export function selectScenarioFromSummaries(summaries: readonly SubagentSummary[]): ChatScenario {
  if (summaries.length === 0) return EMPTY_SCENARIO
  const hit = summariesCache.get(summaries)
  if (hit) return hit
  const scenario = fromSummaries(summaries)
  summariesCache.set(summaries, scenario)
  return scenario
}
