import { describe, expect, it } from 'vitest'
import { fromSummaries } from './fromSummaries'
import { fromTranscript } from './fromTranscript'
import { assistantText, subagentItem, subagentSummary } from './testFixtures'
import type { ChatScenario } from './types'

describe('fromSummaries', () => {
  it('groups contiguous summaries by toolCallId into numbered stages', () => {
    const scenario = fromSummaries([
      subagentSummary({ nameOrTask: 'GateA', toolCallId: 'c1' }),
      subagentSummary({ nameOrTask: 'GateB', toolCallId: 'c1', specIndex: 1 }),
      subagentSummary({ nameOrTask: 'Solo', toolCallId: 'c2', status: 'running' })
    ])
    expect(scenario.stages.map((s) => [s.id, s.number, s.agents.length])).toEqual([
      ['stage:c1', 1, 2],
      ['stage:c2', 2, 1]
    ])
    expect(scenario.stages[0]).toMatchObject({ isParallel: true, cleanTitle: 'Gate' })
    expect(scenario.stages[1]).toMatchObject({ isSingleAgent: true, status: 'running', cleanTitle: 'Solo' })
    expect(scenario.headerStats).toBe('2 stages, 3 agents, 1 running')
  })

  it('pluralises the header: one stage, one agent', () => {
    expect(fromSummaries([subagentSummary({ nameOrTask: 'A' })]).headerStats).toBe('1 stage, 1 agent')
  })

  it('falls back to taskSummary for the outcome and omits it when there is none', () => {
    const [withSummary, without] = fromSummaries([
      subagentSummary({ nameOrTask: 'A', toolCallId: 'c1', taskSummary: 'Reviewed the diff' }),
      subagentSummary({ nameOrTask: 'B', toolCallId: 'c2' })
    ]).stages
    expect(withSummary!.agents[0]!.whatItDid).toBe('Reviewed the diff')
    expect(withSummary!.outcomeSummary).toBe('Reviewed the diff')
    expect(without!.agents[0]).not.toHaveProperty('whatItDid')
    expect(without).not.toHaveProperty('outcomeSummary')
  })

  it('takes the synthesised goal for the title and the summary fields for each agent', () => {
    const scenario = fromSummaries([
      subagentSummary({ nameOrTask: 'A', role: 'Reviewer', overallGoal: 'Ship the fix', filesTouched: ['a.ts'], status: 'running' }),
      subagentSummary({ nameOrTask: 'B', specIndex: 1, overallGoal: 'Ship the fix' })
    ])
    expect(scenario.overallGoal).toBe('Ship the fix')
    expect(scenario.stages[0]!.cleanTitle).toBe('Ship the fix')
    expect(scenario.stages[0]!.agents[0]).toMatchObject({ role: 'Reviewer', filesTouched: ['a.ts'] })
  })

  it('records an agent:// reference in a later stage name as triggeredBy', () => {
    const scenario = fromSummaries([
      subagentSummary({ nameOrTask: 'A1', toolCallId: 'c1' }),
      subagentSummary({ nameOrTask: 'Read agent://A1 result', toolCallId: 'c2' })
    ])
    expect(scenario.stages[1]!.agents[0]!.triggeredBy).toBe('A1')
  })

  it('has no stages and a zeroed header for an empty readout', () => {
    expect(fromSummaries([])).toMatchObject({ stages: [], headerStats: '0 stages, 0 agents' })
  })
})

describe('the two entry points agree on one stage', () => {
  const summaries = [
    subagentSummary({ nameOrTask: 'GateA', role: 'A11y', overallGoal: 'Audit', startedAt: 1000, durationMs: 2000 }),
    subagentSummary({ nameOrTask: 'GateB', specIndex: 1, role: 'Sec', overallGoal: 'Audit', status: 'failed', startedAt: 1000, durationMs: 3000 })
  ]
  const items = [
    subagentItem({ name: 'GateA', specIndex: 0 }),
    subagentItem({ name: 'GateB', specIndex: 1, status: 'error' })
  ]

  it('shows the same title, roles, counts, statuses and totals', () => {
    const fromPanel = fromSummaries(summaries)
    const fromChat = fromTranscript(items, summaries)
    const pick = (s: typeof fromPanel) => ({
      goal: s.overallGoal,
      header: s.headerStats,
      total: s.totalDuration,
      stages: s.stages.map((st) => ({ title: st.cleanTitle, counts: st.counts, rollup: st.rollupText, status: st.status, agents: st.agents.map((a) => [a.name, a.role, a.status, a.duration]) }))
    })
    expect(pick(fromChat)).toEqual(pick(fromPanel))
  })
})

// #2318 defect 2: the drawer read the readout summaries alone, so its Stage title and outcome line fell back to the agent name and the task
// while the chat card, which reads the transcript's task and result text too, showed the goal and the outcome.
describe('the drawer reads the same title and outcome as the chat card (#2318, FR-175..179)', () => {
  const items = [
    subagentItem({ name: 'MemberOne', id: 'c1:MemberOne', toolCallId: 'c1', specIndex: 0, task: 'Confirm Stage members never duplicate the shared goal' }),
    subagentItem({ name: 'MemberTwo', id: 'c1:MemberTwo', toolCallId: 'c1', specIndex: 1, task: 'Confirm Stage members never duplicate the shared goal' }),
    subagentItem({ name: 'SoloSweep', id: 'c2:SoloSweep', toolCallId: 'c2', specIndex: 0, messageId: 'm2', task: 'Sweep the fixture', result: 'Swept clean; every label matched.' })
  ]
  const summaries = items.map((item) => subagentSummary({ nameOrTask: item.name, id: item.id, toolCallId: item.toolCallId, specIndex: item.specIndex }))
  const pick = (scenario: ChatScenario) => scenario.stages.map((stage) => ({ title: stage.cleanTitle, outcome: stage.outcomeSummary, agents: stage.agents.map((agent) => agent.whatItDid) }))

  it('gives every Stage the title and outcome the transcript derives, not the agent names', () => {
    // Mutation: ignore `items` in fromSummaries, so the title and outcome fall back to the names the summaries carry.
    const panel = fromSummaries(summaries, items)
    expect(pick(panel)).toEqual(pick(fromTranscript([items[0]!, items[1]!, assistantText('t'), items[2]!], summaries)))
    expect(panel.stages[1]!.outcomeSummary).toMatch(/^Swept clean/)
  })

  it('still reads from the summaries alone when the transcript has no matching item', () => {
    // Mutation: drop an agent that has no item, or throw on the missing one.
    expect(fromSummaries(summaries, []).stages.map((stage) => stage.agents.length)).toEqual([2, 1])
  })
})
