import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentsGroup } from '../../shared/ipc'
import { subagentSummary } from '../features/subagents/viewModel/testFixtures'
import { EMPTY_AGENT_GROUPS, runningAgentCount, totalRunningAgents, useAgentsStore, visibleAgentGroups } from './agents-store'

function group(sessionId: string, statuses: Array<'running' | 'finished' | 'failed'>): AgentsGroup {
  return {
    sessionId,
    name: sessionId,
    status: 'working',
    subagents: statuses.map((status, index) => subagentSummary({ nameOrTask: `${sessionId}-${index}`, status }))
  }
}

beforeEach(() => useAgentsStore.setState({ groups: EMPTY_AGENT_GROUPS }))

describe('visibleAgentGroups', () => {
  it('hides a Session with no agents', () => {
    expect(visibleAgentGroups([group('s1', []), group('s2', ['running'])]).map((g) => g.sessionId)).toEqual(['s2'])
  })

  it('lists Sessions with a running agent first, keeping Rust order within each half', () => {
    const groups = [group('s1', ['finished']), group('s2', ['running']), group('s3', ['failed']), group('s4', ['running', 'finished'])]
    expect(visibleAgentGroups(groups).map((g) => g.sessionId)).toEqual(['s2', 's4', 's1', 's3'])
  })

  it('returns nothing when no Session has an agent, which is the empty state', () => {
    expect(visibleAgentGroups([group('s1', [])])).toEqual([])
  })
})

describe('running counts', () => {
  it('counts only running agents, per group and across groups', () => {
    expect(runningAgentCount(group('s1', ['running', 'finished', 'running']))).toBe(2)
    expect(totalRunningAgents([group('s1', ['running']), group('s2', ['running', 'failed'])])).toBe(2)
  })
})

describe('apply', () => {
  it('replaces the previous groups wholesale', () => {
    useAgentsStore.getState().apply([group('s1', ['running'])])
    useAgentsStore.getState().apply([group('s2', ['finished'])])
    expect(useAgentsStore.getState().groups.map((g) => g.sessionId)).toEqual(['s2'])
  })
})
