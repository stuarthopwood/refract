import { describe, expect, it } from 'vitest'
import { subagentSummary } from './testFixtures'
import { EMPTY_SCENARIO, selectScenarioFromSummaries } from './selectors'

describe('selectScenarioFromSummaries', () => {
  it('returns the same object for the same array', () => {
    const summaries = [subagentSummary({ nameOrTask: 'A' })]
    expect(selectScenarioFromSummaries(summaries)).toBe(selectScenarioFromSummaries(summaries))
  })

  it('returns a new scenario when the array is replaced', () => {
    const first = [subagentSummary({ nameOrTask: 'A' })]
    expect(selectScenarioFromSummaries(first)).not.toBe(selectScenarioFromSummaries([...first]))
  })

  it('returns one shared empty scenario for any empty array', () => {
    expect(selectScenarioFromSummaries([])).toBe(EMPTY_SCENARIO)
    expect(selectScenarioFromSummaries([])).toBe(selectScenarioFromSummaries([]))
    expect(EMPTY_SCENARIO.stages).toEqual([])
  })
})
