import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentsGroup } from '../../shared/ipc'
import { subagentSummary } from '../features/subagents/viewModel/testFixtures'
import { useRightPaneStore } from './right-pane-store'
import { useSubagentPanelStore } from './subagent-store'
import { EMPTY_AGENT_GROUPS, runningAgentCount, totalRunningAgents, useAgentsStore, visibleAgentGroups } from './agents-store'

function group(sessionId: string, statuses: Array<'running' | 'finished' | 'failed'>): AgentsGroup {
  return {
    sessionId,
    name: sessionId,
    status: 'working',
    subagents: statuses.map((status, index) => subagentSummary({ nameOrTask: `${sessionId}-${index}`, status }))
  }
}

beforeEach(() => {
  useAgentsStore.setState({ groups: EMPTY_AGENT_GROUPS })
  useSubagentPanelStore.setState({ sessionId: null, selectedId: null, selectedKey: null, streams: {} })
})

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

  it('keeps an unchanged group object and replaces only the changed one', () => {
    useAgentsStore.getState().apply([group('s1', ['running']), group('s2', ['running'])])
    const [s1, s2] = useAgentsStore.getState().groups
    useAgentsStore.getState().apply([group('s1', ['running']), group('s2', ['finished'])])
    const [nextS1, nextS2] = useAgentsStore.getState().groups
    expect(nextS1).toBe(s1)
    expect(nextS2).not.toBe(s2)
    expect(nextS2?.subagents[0]?.status).toBe('finished')
  })

  it('keeps the whole list identity when nothing changed', () => {
    useAgentsStore.getState().apply([group('s1', ['running'])])
    const before = useAgentsStore.getState().groups
    useAgentsStore.getState().apply([group('s1', ['running'])])
    expect(useAgentsStore.getState().groups).toBe(before)
  })

  it('ignores a payload that is not an array', () => {
    useAgentsStore.getState().apply([group('s1', ['running'])])
    const before = useAgentsStore.getState().groups
    useAgentsStore.getState().apply(undefined as unknown as AgentsGroup[])
    expect(useAgentsStore.getState().groups).toBe(before)
  })

  it('never opens or closes a panel, even when every group is empty (FR-204)', () => {
    useRightPaneStore.setState({ open: true, openPanelIds: ['subagents'], activePanelId: 'subagents', chatCollapsed: false })
    useAgentsStore.getState().apply([group('s1', ['running'])])
    useAgentsStore.getState().apply([group('s1', []), group('s2', [])])
    useAgentsStore.getState().apply([])
    expect(useRightPaneStore.getState().openPanelIds).toEqual(['subagents'])

    useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, chatCollapsed: false })
    useAgentsStore.getState().apply([group('s3', ['running'])])
    expect(useRightPaneStore.getState().openPanelIds).toEqual([])
  })

  describe('selection follows its Session', () => {
    const bind = (): void =>
      useSubagentPanelStore.setState({ sessionId: 's1', selectedId: 'a', selectedKey: 'c1:0', streams: { a: [] } })

    it('clears the selection and stream when the selected Session group disappears, keeping the panel open', () => {
      useRightPaneStore.setState({ open: true, openPanelIds: ['subagents'], activePanelId: 'subagents', chatCollapsed: false })
      bind()
      useAgentsStore.getState().apply([group('s1', ['running']), group('s2', ['running'])])
      expect(useSubagentPanelStore.getState().selectedId).toBe('a')

      useAgentsStore.getState().apply([group('s2', ['running'])])

      expect(useSubagentPanelStore.getState().selectedId).toBeNull()
      expect(useSubagentPanelStore.getState().streams).toEqual({})
      expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
    })

    it('keeps the selection while its group is still listed, even with no agents left', () => {
      bind()
      useAgentsStore.getState().apply([group('s1', [])])
      expect(useSubagentPanelStore.getState().selectedId).toBe('a')
    })
  })
})
