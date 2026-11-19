// Spec 137 FR-020 (#2075): an explicit Session selection shows a hidden chat; a startup restore never does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentAnnouncementStore } from './agent-announcement-store'
import { useRightPaneStore } from './right-pane-store'
import { useSplitStore } from './split-store'
import { useViewStore } from './view-store'

const pane = () => useRightPaneStore.getState()
const split = () => useSplitStore.getState()

beforeEach(() => {
  const refract = { settings: { setSplit: () => Promise.resolve({ ok: true }) } }
  vi.stubGlobal('window', { refract, setTimeout: () => 0, clearTimeout: () => undefined })
  vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null, getElementById: () => null })
  useRightPaneStore.setState({ open: true, chatCollapsed: true })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0, pristineIds: new Set() })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  useViewStore.setState({ view: 'chat' })
  useAgentAnnouncementStore.setState({ message: '', serial: 0 })
})

afterEach(() => vi.unstubAllGlobals())

describe('selecting a Session while chat is hidden (FR-020)', () => {
  it('shows chat when a Session replaces the focused pane', () => {
    split().replaceFocused('s2')
    expect(pane().chatCollapsed).toBe(false)
    expect(split().paneSessionIds).toEqual(['s2'])
    expect(useAgentAnnouncementStore.getState().message).toBe('Chat shown')
  })

  it('shows chat when a Session opens in a split', () => {
    split().openInSplit('s2')
    expect(pane().chatCollapsed).toBe(false)
    expect(split().paneSessionIds).toEqual(['s1', 's2'])
  })

  it('shows chat when the Session is already the visible one', () => {
    split().replaceFocused('s1')
    expect(pane().chatCollapsed).toBe(false)
  })

  it('shows chat when the selection comes from another view', () => {
    useViewStore.setState({ view: 'home' })
    split().replaceFocused('s2')
    expect(useViewStore.getState().view).toBe('chat')
    expect(pane().chatCollapsed).toBe(false)
  })

  it('leaves a chat that is already shown alone', () => {
    useRightPaneStore.setState({ chatCollapsed: false })
    split().replaceFocused('s2')
    expect(useAgentAnnouncementStore.getState().serial).toBe(0)
  })
})

describe('paths that are not an explicit selection', () => {
  it('a startup restore keeps the stored hidden chat', () => {
    split().restoreFromSettings({ sessionIds: ['s1', 's2'], dividerPercent: 40, focusedIndex: 1 })
    expect(pane().chatCollapsed).toBe(true)
    expect(useAgentAnnouncementStore.getState().serial).toBe(0)
  })

  it('closing a pane or pruning a deleted Session keeps it hidden', () => {
    useSplitStore.setState({ paneSessionIds: ['s1', 's2'] })
    split().closePane(0)
    split().pruneDeleted(new Set())
    expect(pane().chatCollapsed).toBe(true)
  })
})
