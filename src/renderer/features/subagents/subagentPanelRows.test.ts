import { describe, expect, it } from 'vitest'
import type { AgentsGroup } from '../../../shared/ipc'
import { NO_AGENTS_TEXT } from '@/state/agents-store'
import {
  agentElapsedText,
  agentRowKey,
  agentsGroupKey,
  agentsStatusText,
  buildGroupRows,
  expandGroup,
  findSelectedSummary,
  finishedText,
  focusLostToPrune,
  foldGroup,
  groupScrollStep,
  panelFocusRows,
  panelStageToggleId,
  pendingFocusTarget,
  selectedRowKey,
  selectionRoute,
  toggleGroupCollapsed,
  type AgentRow
} from './subagentPanelRows'
import { subagentSummary } from './viewModel/testFixtures'

const group = (sessionId: string, statuses: Array<'running' | 'finished' | 'failed' | 'cancelled' | 'exited' | 'parked'>, name = `Session ${sessionId}`): AgentsGroup => ({
  sessionId,
  name,
  status: 'working',
  subagents: statuses.map((status, index) => subagentSummary({ nameOrTask: `${sessionId}-${index}`, id: `${sessionId}-${index}`, toolCallId: `call-${sessionId}`, specIndex: index, status }))
})
const NO_SELECTION = { selectedId: null, selectedKey: null }

describe('panelStageToggleId', () => {
  it('is keyed apart from the chat card so toggling one never moves the other', () => {
    expect(panelStageToggleId('stage:c1')).toBe('panel:stage:c1')
    expect(panelStageToggleId('stage:c1')).not.toBe('card:stage:c1')
  })
})

describe('foldGroup', () => {
  it('folds every successful finish into one row with the count', () => {
    const rows = foldGroup(group('s1', ['finished', 'finished', 'finished'])).rows
    expect(rows).toEqual([{ kind: 'finished', key: 'finished|s1', count: 3 }])
    expect(finishedText(3)).toBe('3 finished')
  })

  it('keeps failed, cancelled, exited and parked agents as rows of their own', () => {
    const rows = foldGroup(group('s1', ['failed', 'cancelled', 'exited', 'parked', 'finished'])).rows
    expect(rows.map((row) => row.kind)).toEqual(['agent', 'agent', 'agent', 'agent', 'finished'])
    expect(rows.at(-1)).toMatchObject({ count: 1 })
  })

  it('lists running agents before the ones that need attention, each in the order Rust sent them', () => {
    const rows = foldGroup(group('s1', ['failed', 'running', 'exited', 'running'])).rows as AgentRow[]
    expect(rows.map((row) => row.summary.id)).toEqual(['s1-1', 's1-3', 's1-0', 's1-2'])
  })

  it('has no fold row when nothing finished successfully', () => {
    expect(foldGroup(group('s1', ['running'])).rows.some((row) => row.kind === 'finished')).toBe(false)
  })

  it('counts only running agents in the header and carries the header fields', () => {
    expect(foldGroup({ ...group('s1', ['running', 'finished', 'failed']), repositoryName: 'refract' })).toMatchObject({ key: agentsGroupKey('s1'), sessionId: 's1', name: 'Session s1', repositoryName: 'refract', running: 1 })
  })

  it('keys an agent row by Session and instance, so same-named agents of two Sessions never share a key', () => {
    const [a] = foldGroup(group('s1', ['running'])).rows as AgentRow[]
    const [b] = foldGroup(group('s2', ['running'])).rows as AgentRow[]
    expect(a!.key).toBe(agentRowKey('s1', a!.summary))
    expect(a!.key).not.toBe(b!.key)
  })
})

describe('buildGroupRows', () => {
  it('lists Sessions with a running agent first and leaves out the ones with nothing to show', () => {
    const built = buildGroupRows([group('idle', ['finished']), group('empty', []), group('busy', ['running'])])
    expect(built.map((entry) => entry.sessionId)).toEqual(['busy', 'idle'])
  })

  it('is empty when no Session has an agent, which the panel words as the empty state', () => {
    expect(buildGroupRows([group('empty', [])])).toEqual([])
  })
})

describe('agentsStatusText', () => {
  it('is the empty-state text at zero and a counted, pluralised phrase otherwise', () => {
    expect(agentsStatusText(0)).toBe(NO_AGENTS_TEXT)
    expect(agentsStatusText(1)).toBe('1 agent running')
    expect(agentsStatusText(3)).toBe('3 agents running')
  })
})

describe('panelFocusRows', () => {
  const groups = buildGroupRows([group('s1', ['running', 'finished']), group('s2', ['failed'])])

  it('holds every header and the agent rows of open groups, never the fold line', () => {
    expect(panelFocusRows(groups, new Set()).map((row) => row.key)).toEqual([agentsGroupKey('s1'), groups[0]!.rows[0]!.key, agentsGroupKey('s2'), groups[1]!.rows[0]!.key])
  })

  it('drops the rows of a collapsed group but keeps its header', () => {
    expect(panelFocusRows(groups, new Set(['s1'])).map((row) => row.key)).toEqual([agentsGroupKey('s1'), agentsGroupKey('s2'), groups[1]!.rows[0]!.key])
  })
})

describe('toggleGroupCollapsed', () => {
  it('closes an open group, reopens a closed one, and never mutates its input', () => {
    const open = new Set<string>()
    const closed = toggleGroupCollapsed(open, 's1')
    expect([...closed]).toEqual(['s1'])
    expect(open.size).toBe(0)
    expect(toggleGroupCollapsed(closed, 's1').size).toBe(0)
  })
})

describe('groupScrollStep and expandGroup', () => {
  const groups = buildGroupRows([group('s1', ['running']), group('s2', ['running'])])

  it('scrolls to an open group, opens a collapsed one first, and drops a request for a Session that is not listed', () => {
    expect(groupScrollStep(groups, new Set(), 's2')).toBe('scroll')
    expect(groupScrollStep(groups, new Set(['s2']), 's2')).toBe('expand')
    expect(groupScrollStep(groups, new Set(['s2']), 's3')).toBe('drop')
  })

  it('opens only the asked group and never mutates its input', () => {
    const closed = new Set(['s1', 's2'])
    expect([...expandGroup(closed, 's2')]).toEqual(['s1'])
    expect(closed.size).toBe(2)
    expect([...expandGroup(new Set(), 's2')]).toEqual([])
  })
})

describe('agentElapsedText', () => {
  it('ticks a running agent from its start and never goes negative', () => {
    expect(agentElapsedText({ status: 'running', startedAt: 1_000 }, 29_000)).toBe('28s')
    expect(agentElapsedText({ status: 'running', startedAt: 9_000 }, 1_000)).toBe('0s')
  })

  it('reports the recorded duration once settled, and nothing when none was recorded', () => {
    expect(agentElapsedText({ status: 'failed', startedAt: 1_000, durationMs: 74_000 }, 99_000)).toBe('1m 14s')
    expect(agentElapsedText({ status: 'exited', startedAt: 1_000 }, 99_000)).toBeUndefined()
  })
})

describe('selection', () => {
  const groups = buildGroupRows([group('s1', ['running', 'finished']), group('s2', ['running'])])

  it('resolves by the instance key first, then by id', () => {
    const subagents = group('s1', ['running', 'running']).subagents
    expect(findSelectedSummary(subagents, { selectedId: 'wrong', selectedKey: 'call-s1:1' })?.id).toBe('s1-1')
    expect(findSelectedSummary(subagents, { selectedId: 's1-0', selectedKey: 'gone' })?.id).toBe('s1-0')
    expect(findSelectedSummary(subagents, NO_SELECTION)).toBeNull()
  })

  it('marks the selected row only inside the Session the panel is bound to', () => {
    expect(selectedRowKey(groups, 's1', { selectedId: 's1-0', selectedKey: 'call-s1:0' })).toBe(agentRowKey('s1', subagentSummary({ nameOrTask: 'x', toolCallId: 'call-s1', specIndex: 0 })))
    expect(selectedRowKey(groups, 's2', { selectedId: 's1-0', selectedKey: 'call-s1:0' })).toBeNull()
    expect(selectedRowKey(groups, null, NO_SELECTION)).toBeNull()
  })

  it('has no selected row once the selected agent folded into the finished line', () => {
    expect(selectedRowKey(groups, 's1', { selectedId: 's1-1', selectedKey: 'call-s1:1' })).toBeNull()
  })

  it('selects in place inside the bound Session and rebinds from any other', () => {
    expect(selectionRoute('s1', 's1')).toBe('select')
    expect(selectionRoute('s1', 's2')).toBe('rebind')
    expect(selectionRoute(null, 's2')).toBe('rebind')
  })
})

describe('pendingFocusTarget', () => {
  const groups = buildGroupRows([group('s1', ['running', 'finished'])])

  it('targets the requested agent by key, then by id', () => {
    expect(pendingFocusTarget(groups, 's1', { pendingFocusKey: 'call-s1:0', pendingFocusId: null })).toBe(groups[0]!.rows[0]!.key)
    expect(pendingFocusTarget(groups, 's1', { pendingFocusKey: null, pendingFocusId: 's1-0' })).toBe(groups[0]!.rows[0]!.key)
  })

  it('falls back to the Session header for an agent folded into the finished line', () => {
    expect(pendingFocusTarget(groups, 's1', { pendingFocusKey: 'call-s1:1', pendingFocusId: null })).toBe(agentsGroupKey('s1'))
  })

  it('is null with no request, for another Session, or for an agent that is not listed', () => {
    expect(pendingFocusTarget(groups, 's1', { pendingFocusKey: null, pendingFocusId: null })).toBeNull()
    expect(pendingFocusTarget(groups, 's2', { pendingFocusKey: 'call-s1:0', pendingFocusId: null })).toBeNull()
    expect(pendingFocusTarget(buildGroupRows([group('s1', ['running'])]), 's1', { pendingFocusKey: 'nope:0', pendingFocusId: null })).toBeNull()
  })
})

describe('focusLostToPrune', () => {
  const rows = [{ key: 'a' }, { key: 'b' }]
  const withoutB = [{ key: 'a' }]

  it('is true when the focused row was pruned and focus fell to the page body', () => {
    expect(focusLostToPrune('b', withoutB, true)).toBe(true)
  })

  it('is false while another control holds focus, so a prune never pulls it away', () => {
    expect(focusLostToPrune('b', withoutB, false)).toBe(false)
  })

  it('is false while the focused row is still listed, or when focus was never in a row', () => {
    expect(focusLostToPrune('b', rows, true)).toBe(false)
    expect(focusLostToPrune(null, withoutB, true)).toBe(false)
  })

  it('is true for an empty list once everything was pruned', () => {
    expect(focusLostToPrune('b', [], true)).toBe(true)
  })
})
