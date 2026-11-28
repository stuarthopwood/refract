import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../shared/model'
import { subagentSummary } from '../features/subagents/viewModel/testFixtures'
import { EMPTY_READOUT, useReadoutStore } from './readout-store'
import { useRightPaneStore } from './right-pane-store'
import { useSubagentPanelStore } from './subagent-store'

const panel = () => useSubagentPanelStore.getState()
const stream = (id: string): TranscriptItem[] => [{ kind: 'assistant-text', id, text: id, streaming: false }]
const remaining = (...ids: string[]) => ids.map((id) => ({ id }))

interface PanelBinding {
  sessionId: string | null
  selectedId: string | null
  selectedKey: string | null
  streams: Record<string, TranscriptItem[]>
}

function bindPanel(overrides: Partial<PanelBinding> = {}): void {
  useSubagentPanelStore.setState({
    sessionId: 's1',
    selectedId: 'a',
    selectedKey: 'c1:0',
    streams: { a: stream('a'), b: stream('b') },
    suspended: false,
    ...overrides
  })
}

beforeEach(() => {
  vi.stubGlobal('window', { refract: { chat: { setVisibleSubagent: vi.fn().mockResolvedValue(undefined) } } })
  useSubagentPanelStore.setState({ sessionId: null, selectedId: null, selectedKey: null, streams: {}, suspended: false, openerEl: null, pendingFocusSubagentId: null, pendingFocusSubagentKey: null })
  useRightPaneStore.setState({ open: true, openPanelIds: ['subagents'], activePanelId: 'subagents', chatCollapsed: false })
  useReadoutStore.setState({ bySession: {} })
})

describe('clearSelectionForSession', () => {
  it('clears the selection but keeps the panel open when the bound Session is deleted', () => {
    bindPanel()
    panel().clearSelectionForSession('s1')
    expect(panel().selectedId).toBeNull()
    expect(panel().streams).toEqual({})
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
  })

  it('leaves a selection that belongs to another Session', () => {
    bindPanel()
    panel().clearSelectionForSession('s2')
    expect(panel().selectedId).toBe('a')
  })
})

describe('dropPrunedSelection', () => {
  it('clears the selection and its cached stream when the selected agent was pruned, keeping other streams', () => {
    bindPanel()
    panel().dropPrunedSelection('s1', remaining('b'))
    expect(panel().selectedId).toBeNull()
    expect(panel().selectedKey).toBeNull()
    expect(panel().streams).toEqual({ b: stream('b') })
  })

  it('keeps the panel open and bound to its Session', () => {
    bindPanel()
    panel().dropPrunedSelection('s1', [])
    expect(panel().sessionId).toBe('s1')
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
  })

  it('leaves everything alone while the selected agent is still listed', () => {
    bindPanel()
    panel().dropPrunedSelection('s1', remaining('a', 'b'))
    expect(panel().selectedId).toBe('a')
    expect(panel().selectedKey).toBe('c1:0')
    expect(Object.keys(panel().streams)).toEqual(['a', 'b'])
  })

  it('does nothing when no agent is selected', () => {
    bindPanel({ selectedId: null, selectedKey: null })
    panel().dropPrunedSelection('s1', [])
    expect(Object.keys(panel().streams)).toEqual(['a', 'b'])
  })

  it('ignores a prune of another Session, or when the panel is bound to none', () => {
    bindPanel()
    panel().dropPrunedSelection('s2', [])
    expect(panel().selectedId).toBe('a')
    bindPanel({ sessionId: null })
    panel().dropPrunedSelection('s1', [])
    expect(panel().selectedId).toBe('a')
  })
})

describe('applySubagents feeds dropPrunedSelection', () => {
  const readout = (...ids: string[]) => ids.map((id) => subagentSummary({ nameOrTask: id, id }))

  it('clears the selection when a Stage prune removes the selected agent but others remain', () => {
    bindPanel()
    useReadoutStore.getState().reset('s1', EMPTY_READOUT, readout('a', 'b'))
    useReadoutStore.getState().applySubagents('s1', readout('b'))
    expect(panel().selectedId).toBeNull()
    expect(panel().streams).toEqual({ b: stream('b') })
    expect(panel().sessionId).toBe('s1')
  })

  it('keeps the selection while its agent is still in the new list', () => {
    bindPanel()
    useReadoutStore.getState().reset('s1', EMPTY_READOUT, readout('a', 'b'))
    useReadoutStore.getState().applySubagents('s1', readout('a'))
    expect(panel().selectedId).toBe('a')
  })

  it('keeps the panel open on its empty state when a prune empties the list', () => {
    bindPanel({ streams: { a: stream('a') } })
    useReadoutStore.getState().reset('s1', EMPTY_READOUT, readout('a'))
    useReadoutStore.getState().applySubagents('s1', [])
    expect(panel().sessionId).toBe('s1')
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
    expect(panel().selectedId).toBeNull()
    expect(panel().streams).toEqual({})
  })
})

describe('resetForNewConversation', () => {
  it('closes the open panel for its own Session', () => {
    bindPanel()
    panel().resetForNewConversation('s1')
    expect(panel().sessionId).toBeNull()
    expect(useRightPaneStore.getState().openPanelIds).not.toContain('subagents')
  })

  it('ignores another Session', () => {
    bindPanel()
    panel().resetForNewConversation('s2')
    expect(panel().sessionId).toBe('s1')
  })
})

describe('group scroll request', () => {
  it('holds the asked Session until consumed and is dropped when the panel closes', () => {
    bindPanel()
    panel().requestGroupScroll('s2')
    expect(panel().scrollToGroupSessionId).toBe('s2')
    panel().clearGroupScroll()
    expect(panel().scrollToGroupSessionId).toBeNull()
    panel().requestGroupScroll('s2')
    panel().closePanel({ restoreFocus: false })
    expect(panel().scrollToGroupSessionId).toBeNull()
  })
})
