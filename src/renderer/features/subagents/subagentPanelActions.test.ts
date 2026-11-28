import { describe, expect, it, vi } from 'vitest'
import type { AgentsGroup } from '../../../shared/ipc'
import { consumeGroupScroll, scrollHostToGroup, selectAgentRow } from './subagentPanelActions'
import { buildGroupRows, type AgentRow } from './subagentPanelRows'
import { agentKey } from './viewModel/fromTranscript'
import { subagentSummary } from './viewModel/testFixtures'

const group: AgentsGroup = { sessionId: 's1', name: 'Fix login', status: 'working', subagents: [subagentSummary({ id: 'a', nameOrTask: 'Alpha', toolCallId: 'c1', specIndex: 2, status: 'running' })] }
const groups = buildGroupRows([group])
const row = groups[0]!.rows.find((candidate): candidate is AgentRow => candidate.kind === 'agent')!

function effects() {
  return { expand: vi.fn(), scroll: vi.fn(), clear: vi.fn() }
}

describe('consumeGroupScroll', () => {
  it('opens a closed group and leaves the request pending for the re-render', () => {
    const fx = effects()
    consumeGroupScroll(groups, new Set(['s1']), 's1', fx)
    expect(fx.expand).toHaveBeenCalledOnce()
    expect(fx.scroll).not.toHaveBeenCalled()
    expect(fx.clear).not.toHaveBeenCalled()
  })

  it('scrolls an open group, then clears the request', () => {
    const fx = effects()
    consumeGroupScroll(groups, new Set(), 's1', fx)
    expect(fx.expand).not.toHaveBeenCalled()
    expect(fx.scroll).toHaveBeenCalledOnce()
    expect(fx.clear).toHaveBeenCalledOnce()
  })

  it('drops a request for a Session that is not listed without scrolling', () => {
    const fx = effects()
    consumeGroupScroll(groups, new Set(), 'gone', fx)
    expect(fx.scroll).not.toHaveBeenCalled()
    expect(fx.clear).toHaveBeenCalledOnce()
  })
})

describe('scrollHostToGroup', () => {
  it('moves the host by the group offset from its top edge, on top of where it already is', () => {
    const host = { scrollTop: 40, getBoundingClientRect: () => ({ top: 100 }) }
    scrollHostToGroup(host, { getBoundingClientRect: () => ({ top: 260 }) })
    expect(host.scrollTop).toBe(200)
  })

  it('scrolls back up for a group above the visible top', () => {
    const host = { scrollTop: 300, getBoundingClientRect: () => ({ top: 100 }) }
    scrollHostToGroup(host, { getBoundingClientRect: () => ({ top: 50 }) })
    expect(host.scrollTop).toBe(250)
  })
})

describe('selectAgentRow', () => {
  const key = agentKey('c1', 2)

  it('selects in place when the row belongs to the bound Session', () => {
    const selectSubagent = vi.fn()
    const openPanel = vi.fn()
    selectAgentRow('s1', 's1', row, { selectSubagent, openPanel })
    expect(selectSubagent).toHaveBeenCalledWith('a', key)
    expect(openPanel).not.toHaveBeenCalled()
  })

  it.each([['another Session', 's0'], ['no bound Session', null]])('rebinds the panel through openPanel for %s', (_name, bound) => {
    const selectSubagent = vi.fn()
    const openPanel = vi.fn()
    selectAgentRow(bound, 's1', row, { selectSubagent, openPanel })
    expect(openPanel).toHaveBeenCalledWith('s1', { selectSubagentId: 'a', selectSubagentKey: key })
    expect(selectSubagent).not.toHaveBeenCalled()
  })
})
