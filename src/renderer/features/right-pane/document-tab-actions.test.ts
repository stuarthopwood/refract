import { beforeEach, describe, expect, it, vi } from 'vitest'

const announce = vi.hoisted(() => vi.fn())
vi.mock('@/state/agent-announcement-store', () => ({ useAgentAnnouncementStore: { getState: () => ({ announce }) } }))

import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { applyCloseResult, bulkCloseAnnouncement, runBulkClose } from './document-tab-actions'

const open = (path: string, activate = false) => useDocumentTabsStore.getState().openDocumentTab('s1', { kind: 'file', path }, { activate })

beforeEach(() => {
  announce.mockReset()
  useDocumentTabsStore.setState({ bySession: {} })
  useRightPaneStore.setState({ open: true, openPanelIds: ['outline'], activePanelId: 'outline', activeTabKey: { kind: 'panel', id: 'outline' } })
})

describe('bulkCloseAnnouncement', () => {
  it('announces the count with a singular or plural noun', () => {
    expect(bulkCloseAnnouncement('others', 1)).toBe('Closed 1 other tab')
    expect(bulkCloseAnnouncement('all', 3)).toBe('Closed 3 file and diff tabs')
    expect(bulkCloseAnnouncement('stale', 2)).toBe('Closed 2 no-longer-changed tabs')
  })
})

describe('runBulkClose', () => {
  it('closes every other document tab, keeps the named one and announces the count', () => {
    open('a.ts')
    open('b.ts')
    const { id } = open('c.ts', true)
    useRightPaneStore.getState().activateTab({ kind: 'document', sessionId: 's1', id })
    runBulkClose('s1', 'others', id)
    expect(useDocumentTabsStore.getState().bySession.s1?.tabs.map((tab) => tab.id)).toEqual([id])
    expect(announce).toHaveBeenCalledWith('Closed 2 other tabs')
  })

  it('returns the selection to the panel tab when the active document closes with nothing left', () => {
    const { id } = open('a.ts', true)
    useRightPaneStore.getState().activateTab({ kind: 'document', sessionId: 's1', id })
    runBulkClose('s1', 'all', null)
    expect(useRightPaneStore.getState().activeTabKey).toEqual({ kind: 'panel', id: 'outline' })
    expect(announce).toHaveBeenCalledWith('Closed 1 file and diff tab')
  })

  it('closes only dead tabs for the no-longer-changed action', () => {
    const { id } = open('a.ts')
    open('b.ts')
    useDocumentTabsStore.getState().markDead('s1', id, true)
    runBulkClose('s1', 'stale', null)
    expect(useDocumentTabsStore.getState().bySession.s1?.tabs.map((tab) => tab.id)).toEqual(['file:b.ts'])
  })

  it('stays silent when nothing closes', () => {
    open('a.ts')
    runBulkClose('s1', 'stale', null)
    expect(announce).not.toHaveBeenCalled()
  })
})

describe('applyCloseResult', () => {
  it('leaves the selection alone when the active tab did not change', () => {
    applyCloseResult('s1', { closed: [], activeChanged: false, next: null })
    expect(useRightPaneStore.getState().activeTabKey).toEqual({ kind: 'panel', id: 'outline' })
  })
})
