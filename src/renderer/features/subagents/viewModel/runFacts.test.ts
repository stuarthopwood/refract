import { describe, expect, it } from 'vitest'
import { runFacts } from './runFacts'
import { subagentItem } from './testFixtures'

describe('runFacts', () => {
  it('derives the context, agent refs and result summaries of a run', () => {
    const facts = runFacts([
      subagentItem({ name: 'A', id: 'rf1:A', context: '# Goal: ship it', task: 'Check agent://Prev-1/out', result: '## Passed\nmore' }),
      subagentItem({ name: 'B', id: 'rf1:B', specIndex: 1, context: '# Goal: ship it' })
    ])
    expect(facts.context).toBe('# Goal: ship it')
    expect(facts.agentRefs).toEqual(['Prev-1'])
    expect(facts.resultSummaries).toEqual(['Passed', undefined])
  })

  it('reuses the same facts for an unchanged run, even from a fresh items array', () => {
    const make = () => [subagentItem({ name: 'A', id: 'rf2:A', result: 'Done' })]
    expect(runFacts(make())).toBe(runFacts(make()))
  })

  it('recomputes when a result changes', () => {
    const before = runFacts([subagentItem({ name: 'A', id: 'rf3:A' })])
    const after = runFacts([subagentItem({ name: 'A', id: 'rf3:A', result: 'Now done' })])
    expect(after).not.toBe(before)
    expect(after.resultSummaries).toEqual(['Now done'])
  })

  it('recomputes when a task or the run membership changes', () => {
    const base = runFacts([subagentItem({ name: 'A', id: 'rf4:A' })])
    expect(runFacts([subagentItem({ name: 'A', id: 'rf4:A', task: 'See agent://X' })])).not.toBe(base)
    const grown = runFacts([subagentItem({ name: 'A', id: 'rf4:A', task: 'See agent://X' }), subagentItem({ name: 'B', id: 'rf4:B', specIndex: 1 })])
    expect(grown.resultSummaries).toHaveLength(2)
  })
})
