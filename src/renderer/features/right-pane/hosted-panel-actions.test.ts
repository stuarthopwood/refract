// FR-207 (#490): opening the Agents panel for a Session asks it to scroll that Session's group into view.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubagentPanelStore } from '@/state'
import { openHostedPanel } from './hosted-panel-actions'

// Store modules touch `window`/`document` at import time, so the stubs must exist before the imports run.
vi.hoisted(() => {
  const noop = (): undefined => undefined
  vi.stubGlobal('window', { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), refract: { settings: { setSplit: () => Promise.resolve({ ok: true }) }, chat: { setVisibleSubagent: () => Promise.resolve() } }, setTimeout: () => 0, clearTimeout: noop })
  vi.stubGlobal('document', { addEventListener: noop, hidden: false, visibilityState: 'visible', activeElement: null, body: {}, querySelector: () => null, getElementById: () => null, documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, classList: { toggle: noop, add: noop, remove: noop } } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
})
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }) }))

beforeEach(() => {
  useSubagentPanelStore.setState({ sessionId: null, selectedId: null, selectedKey: null, streams: {}, suspended: false, scrollToGroupSessionId: null })
})

describe('openHostedPanel for the Agents panel', () => {
  it('binds the panel to the Session and requests its group', () => {
    openHostedPanel('subagents', 's1')
    expect(useSubagentPanelStore.getState().sessionId).toBe('s1')
    expect(useSubagentPanelStore.getState().scrollToGroupSessionId).toBe('s1')
  })

  it('leaves the scroll to the focused row when an agent is selected', () => {
    openHostedPanel('subagents', 's1', { selectSubagentId: 'a', selectSubagentKey: 'c1:0' })
    expect(useSubagentPanelStore.getState().scrollToGroupSessionId).toBeNull()
  })

  it('requests nothing for another panel', () => {
    openHostedPanel('outline', 's1')
    expect(useSubagentPanelStore.getState().scrollToGroupSessionId).toBeNull()
  })
})
