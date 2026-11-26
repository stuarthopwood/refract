import { describe, expect, it } from 'vitest'
import { summarizeSubagentStatuses, type SubagentRowStatus } from '../subagentStatus'
import { selectScenarioFromSummaries } from '../viewModel/selectors'
import { subagentSummary } from '../viewModel/testFixtures'
import { formatHeaderStats, formatProgressText, formatProgressValueText, stageSegmentState, stageSegmentStates } from './headerStats'

const stats = (stageCount: number, agentCount: number, statuses: SubagentRowStatus[]) =>
  formatHeaderStats({ stageCount, agentCount, statusCounts: summarizeSubagentStatuses(statuses) })

describe('formatHeaderStats', () => {
  it('reads "3 stages, 5 agents, 1 running" with the running part when something runs', () => {
    expect(stats(3, 5, ['running', 'finished', 'finished', 'finished', 'finished'])).toBe('3 stages, 5 agents, 1 running')
  })

  it('uses the singular for exactly one', () => {
    expect(stats(1, 1, ['running'])).toBe('1 stage, 1 agent, 1 running')
  })

  it('uses the plural for zero', () => {
    expect(stats(0, 0, [])).toBe('0 stages, 0 agents')
  })

  it('drops the zero "running" part once everything settled', () => {
    const text = stats(2, 3, ['finished', 'finished', 'finished'])
    expect(text).toBe('2 stages, 3 agents')
    expect(text).not.toContain('running')
    expect(text).not.toContain('0')
  })

  it('keeps unsettled counts other than running and drops their zero parts', () => {
    expect(stats(2, 3, ['finished', 'failed', 'cancelled'])).toBe('2 stages, 3 agents, 1 failed, 1 cancelled')
  })

  it('matches the view-model headerStats for the same Stages', () => {
    const scenario = selectScenarioFromSummaries([
      subagentSummary({ nameOrTask: 'A', toolCallId: 'c1', status: 'finished', startedAt: 1000, durationMs: 500 }),
      subagentSummary({ nameOrTask: 'B', toolCallId: 'c2', status: 'running' })
    ])
    const agents = scenario.stages.flatMap((stage) => stage.agents)
    expect(stats(scenario.stages.length, agents.length, agents.map((agent) => agent.status))).toBe(scenario.headerStats)
  })
})

describe('progress text', () => {
  it('formats the visible "X/Y done"', () => {
    expect(formatProgressText(2, 4)).toBe('2/4 done')
    expect(formatProgressText(0, 4)).toBe('0/4 done')
    expect(formatProgressText(4, 4)).toBe('4/4 done')
  })

  it('formats the accessible "X of Y stages done" with a singular stage', () => {
    expect(formatProgressValueText(2, 4)).toBe('2 of 4 stages done')
    expect(formatProgressValueText(0, 3)).toBe('0 of 3 stages done')
    expect(formatProgressValueText(1, 1)).toBe('1 of 1 stage done')
  })
})

describe('segment states', () => {
  it('maps finished to done, running to running', () => {
    expect(stageSegmentState('finished')).toBe('done')
    expect(stageSegmentState('running')).toBe('running')
  })

  it.each<SubagentRowStatus>(['failed', 'cancelled', 'exited', 'parked'])('does not count a %s Stage as done or running', (status) => {
    expect(stageSegmentState(status)).toBe('queued')
  })

  it('maps Stages in order', () => {
    expect(stageSegmentStates([{ status: 'finished' }, { status: 'running' }, { status: 'parked' }])).toEqual(['done', 'running', 'queued'])
    expect(stageSegmentStates([])).toEqual([])
  })
})
