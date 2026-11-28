// FR-204: the Agents panel is global, so closing the pane of the Session it is bound to leaves it open.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRightPaneStore, useSplitStore, useSubagentPanelStore } from '@/state'
import { closeChatPane } from './closeChatPane'

// Store modules touch `window`/`document` at import time, so the stubs must exist before the imports run.
vi.hoisted(() => {
  const noop = (): undefined => undefined
  vi.stubGlobal('window', { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), refract: { settings: { setSplit: () => Promise.resolve({ ok: true }) }, chat: { setVisibleSubagent: () => Promise.resolve() } }, setTimeout: () => 0, clearTimeout: noop })
  vi.stubGlobal('document', { addEventListener: noop, hidden: false, visibilityState: 'visible', activeElement: null, body: {}, querySelector: () => null, getElementById: () => null, documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, classList: { toggle: noop, add: noop, remove: noop } } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/focus', () => ({ focusPaneContent: vi.fn(), focusSessionRow: vi.fn(() => true), focusSessionsNav: vi.fn() }))

beforeEach(() => {
  useSplitStore.setState({ paneSessionIds: ['s1', 's2'], focusedIndex: 0 })
  useSubagentPanelStore.setState({ sessionId: 's1', selectedId: null, selectedKey: null, streams: {}, suspended: false })
  useRightPaneStore.getState().openPanel('subagents', { focus: false })
})

describe('closeChatPane', () => {
  it('closes the pane but leaves the Agents panel open and bound, even for the Session it was bound to', () => {
    closeChatPane(0)
    expect(useSplitStore.getState().paneSessionIds).toEqual(['s2'])
    expect(useSubagentPanelStore.getState().sessionId).toBe('s1')
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
  })
})
