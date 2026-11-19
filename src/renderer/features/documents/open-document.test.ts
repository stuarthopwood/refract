import { beforeEach, describe, expect, it, vi } from 'vitest'

const announce = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
vi.mock('@/state/agent-announcement-store', () => ({ useAgentAnnouncementStore: { getState: () => ({ announce }) } }))
vi.mock('sonner', () => ({ toast }))

import { MAX_DOCUMENT_TABS_PER_SESSION } from '../../../shared/rightPane'
import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { evictionMessage, openDocument } from './open-document'

const file = (path: string) => ({ kind: 'file' as const, path })
const tabs = () => useDocumentTabsStore.getState().bySession.s1?.tabs.map((tab) => tab.id) ?? []

beforeEach(() => {
  announce.mockReset()
  toast.mockReset()
  useDocumentTabsStore.setState({ bySession: {} })
  useRightPaneStore.setState({
    open: false,
    openPanelIds: ['file-explorer'],
    activePanelId: 'file-explorer',
    activeTabKey: { kind: 'panel', id: 'file-explorer' },
    suppressNextContentFocus: false
  })
})

describe('openDocument', () => {
  it('opens and selects the tab, shows the pane and records the opener', () => {
    const { id } = openDocument('s1', file('a.ts'))
    expect(useRightPaneStore.getState().activeTabKey).toEqual({ kind: 'document', sessionId: 's1', id })
    expect(useRightPaneStore.getState().open).toBe(true)
    expect(useDocumentTabsStore.getState().bySession.s1?.openedFrom[id]).toEqual({ kind: 'panel', id: 'file-explorer' })
  })

  it('activates an existing tab instead of duplicating it', () => {
    openDocument('s1', file('a.ts'))
    openDocument('s1', file('b.ts'))
    openDocument('s1', file('a.ts'))
    expect(tabs()).toEqual(['file:a.ts', 'file:b.ts'])
    expect(useRightPaneStore.getState().activeTabKey).toMatchObject({ id: 'file:a.ts' })
  })

  it('opens in the background without moving the selection', () => {
    openDocument('s1', file('a.ts'), { background: true })
    expect(tabs()).toEqual(['file:a.ts'])
    expect(useRightPaneStore.getState().activeTabKey).toEqual({ kind: 'panel', id: 'file-explorer' })
    expect(useRightPaneStore.getState().open).toBe(false)
  })

  it('suppresses content focus only when asked not to focus', () => {
    openDocument('s1', file('a.ts'))
    expect(useRightPaneStore.getState().suppressNextContentFocus).toBe(false)
    openDocument('s1', file('b.ts'), { focus: false })
    expect(useRightPaneStore.getState().suppressNextContentFocus).toBe(true)
  })

  it('sets the focus flag only for a new tab, so an existing tab cannot leave it stale', () => {
    openDocument('s1', file('a.ts'))
    const { existed } = openDocument('s1', file('a.ts'), { focus: false })
    expect(existed).toBe(true)
    expect(useRightPaneStore.getState().suppressNextContentFocus).toBe(false)
  })

  it('reports whether the tab already existed', () => {
    expect(openDocument('s1', file('a.ts')).existed).toBe(false)
    expect(openDocument('s1', file('a.ts')).existed).toBe(true)
  })

  it('announces the caller text and the eviction in one call', () => {
    for (let i = 0; i < MAX_DOCUMENT_TABS_PER_SESSION; i++) openDocument('s1', file(`dir/f${i}.ts`), { background: true })
    openDocument('s1', file('dir/new.ts'), { announce: 'Agent opened new.ts' })
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith('Agent opened new.ts. Closed f0.ts (20-tab limit)')
  })

  it('announces just the caller text when nothing is evicted', () => {
    openDocument('s1', file('a.ts'), { background: true, announce: 'Opened a.ts in the background' })
    expect(announce).toHaveBeenCalledWith('Opened a.ts in the background')
    expect(toast).not.toHaveBeenCalled()
  })

  it('announces and toasts the tab it evicts at the cap', () => {
    for (let i = 0; i < MAX_DOCUMENT_TABS_PER_SESSION; i++) openDocument('s1', file(`dir/f${i}.ts`), { background: true })
    openDocument('s1', file('dir/new.ts'))
    expect(tabs()).toHaveLength(MAX_DOCUMENT_TABS_PER_SESSION)
    expect(announce).toHaveBeenCalledWith('Closed f0.ts (20-tab limit)')
    expect(toast).toHaveBeenCalledWith('Closed f0.ts (20-tab limit)')
  })

  it('stays silent when nothing is evicted', () => {
    openDocument('s1', file('a.ts'))
    expect(announce).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('evictionMessage', () => {
  it('names the file by its last path segment', () => {
    expect(evictionMessage({ path: 'src/deep/Foo.ts' })).toBe('Closed Foo.ts (20-tab limit)')
  })
})
