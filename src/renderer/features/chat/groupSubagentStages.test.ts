import { describe, expect, it } from 'vitest'
import { assistantText, subagentItem, subagentSummary } from '../subagents/viewModel/testFixtures'
import { groupSubagentStages, isStageGroup } from './groupSubagentStages'

describe('groupSubagentStages', () => {
  it('keeps non-subagent items in place around each Stage group', () => {
    const text1 = assistantText('t1')
    const text2 = assistantText('t2')
    const grouped = groupSubagentStages(
      [text1, subagentItem({ name: 'A' }), text2, subagentItem({ name: 'B', id: 'call2:B', toolCallId: 'call2', messageId: 'm2' })],
      []
    )
    expect(grouped.map((g) => g.kind)).toEqual(['assistant-text', 'stage-group', 'assistant-text', 'stage-group'])
    expect(grouped[0]).toBe(text1)
    expect(grouped[2]).toBe(text2)
  })

  it('makes text between two task() calls of one message one Stage with both agents, the text after its card', () => {
    // Mutation: split the run on the text, so the message gets two cards that both read "Stage 1" while the panel counts one.
    const text = assistantText('t1')
    const grouped = groupSubagentStages([subagentItem({ name: 'A' }), text, subagentItem({ name: 'B', id: 'call2:B', toolCallId: 'call2' })], [])
    expect(grouped.map((g) => g.kind)).toEqual(['stage-group', 'assistant-text'])
    const [stage] = grouped.filter(isStageGroup)
    expect(stage!.items.map((i) => i.name)).toEqual(['A', 'B'])
    expect(stage!.view.agents.map((agent) => agent.name)).toEqual(['A', 'B'])
    expect([stage!.stageIndex, stage!.totalStages]).toEqual([1, 1])
  })

  it('numbers each Stage and reports the total', () => {
    const stages = groupSubagentStages(
      [subagentItem({ name: 'A' }), assistantText('t1'), subagentItem({ name: 'B', id: 'call2:B', toolCallId: 'call2', messageId: 'm2' })],
      []
    ).filter(isStageGroup)
    expect(stages.map((s) => [s.stageIndex, s.totalStages])).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  it('keeps the Session number of a Stage when the Session numbering gives one', () => {
    const numbers = new Map([['m0', 1], ['m1', 2], ['m2', 3]])
    const stages = groupSubagentStages([subagentItem({ name: 'B', id: 'call2:B', toolCallId: 'call2', messageId: 'm2' })], [], numbers).filter(isStageGroup)
    expect(stages.map((s) => s.stageIndex)).toEqual([3])
  })

  it('carries the run items, context and view on the group', () => {
    const [stage] = groupSubagentStages([subagentItem({ name: 'A', context: 'Ship the thing' })], []).filter(isStageGroup)
    expect(stage!.items).toHaveLength(1)
    expect(stage!.context).toBe('Ship the thing')
    expect(stage!.view.cleanTitle).toBe('Ship the thing')
  })

  it('overlays a readout summary on the matching item', () => {
    const [stage] = groupSubagentStages(
      [subagentItem({ name: 'A', status: 'running' })],
      [subagentSummary({ nameOrTask: 'A', id: 'call1:A', status: 'finished', taskSummary: 'Did the work' })]
    ).filter(isStageGroup)
    expect(stage!.view.agents[0]).toMatchObject({ status: 'finished', whatItDid: 'Did the work' })
  })

  it('renders an item with no summary from itself', () => {
    const [stage] = groupSubagentStages([subagentItem({ name: 'A', status: 'running' })], []).filter(isStageGroup)
    expect(stage!.view.agents[0]).toMatchObject({ status: 'running' })
  })
})
