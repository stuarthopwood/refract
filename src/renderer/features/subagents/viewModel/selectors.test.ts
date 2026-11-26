import { describe, expect, it } from 'vitest'
import { assistantText, subagentItem, subagentSummary } from './testFixtures'
import { EMPTY_SCENARIO, selectScenarioFromSummaries, selectScenarioFromTranscript } from './selectors'

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

describe('selectScenarioFromTranscript', () => {
  const items = [assistantText('t1'), subagentItem({ name: 'A' })]
  const summaries = [subagentSummary({ nameOrTask: 'A' })]

  it('returns the same object while both inputs keep their identity', () => {
    expect(selectScenarioFromTranscript(items, summaries)).toBe(selectScenarioFromTranscript(items, summaries))
  })

  it('recomputes when either input is replaced', () => {
    const base = selectScenarioFromTranscript(items, summaries)
    expect(selectScenarioFromTranscript([...items], summaries)).not.toBe(base)
    expect(selectScenarioFromTranscript(items, [...summaries])).not.toBe(base)
  })
})
