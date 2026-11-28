import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../../../shared/ipc'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSubagentPanelStore } from '@/state/subagent-store'
import { applySnapshot } from './applySnapshot'

vi.mock('@/state', () => {
  const stub = () => ({ getState: () => ({ reset: vi.fn(), apply: vi.fn(), setForSession: vi.fn() }) })
  return {
    useAdvisorStore: stub(),
    useQueueStore: stub(),
    usePendingRequestsStore: stub(),
    useReadoutStore: stub(),
    useTranscriptStore: stub()
  }
})

const snapshot = {
  runtime: { transcript: [], queue: { followUp: [], steering: [] }, pending: [] },
  readout: {},
  subagents: [],
  advisorOn: false
} as unknown as SessionSnapshot

describe('applySnapshot', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { refract: { chat: { setVisibleSubagent: vi.fn().mockResolvedValue(undefined) } } })
    useSubagentPanelStore.setState({ sessionId: 's1', selectedId: 'a', selectedKey: 'c1:0', streams: {} })
    useRightPaneStore.setState({ open: true, openPanelIds: ['subagents'], activePanelId: 'subagents', chatCollapsed: false })
  })

  it('leaves the global Agents panel open and bound when a pane mounts for another Session', () => {
    applySnapshot('s2', snapshot)
    expect(useSubagentPanelStore.getState().sessionId).toBe('s1')
    expect(useSubagentPanelStore.getState().selectedId).toBe('a')
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
  })
})
