import { beforeEach, describe, expect, it, vi } from 'vitest'

const announce = vi.hoisted(() => vi.fn())
const focusExistingDocumentTab = vi.hoisted(() => vi.fn())
vi.mock('@/state/agent-announcement-store', () => ({ useAgentAnnouncementStore: { getState: () => ({ announce }) } }))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('../document-tab-focus', () => ({ focusExistingDocumentTab }))

import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { frontActiveTab, useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { rowOpenOptions } from '../file-explorer/row-open'
import { clickActivation, diffOpenAnnouncement, enterActivation, openDiffFromRow } from './diff-row-open'

const click = (over: Partial<{ detail: number; ctrlKey: boolean; metaKey: boolean }> = {}) => clickActivation({ detail: 1, ctrlKey: false, metaKey: false, ...over })

describe('clickActivation', () => {
  it('treats a pointer click as a foreground open that leaves focus alone', () => {
    expect(rowOpenOptions(click())).toEqual({ background: false, focus: false })
  })

  it('opens Ctrl+click in the background', () => {
    expect(rowOpenOptions(click({ ctrlKey: true })).background).toBe(true)
  })

  it('treats a click with no pointer detail, which Enter and Space produce, as keyboard activation', () => {
    expect(rowOpenOptions(click({ detail: 0 }))).toEqual({ background: false, focus: true })
  })

  it('opens Ctrl+Enter in the background', () => {
    expect(rowOpenOptions(click({ detail: 0, ctrlKey: true })).background).toBe(true)
  })
})

describe('diffOpenAnnouncement', () => {
  it('names the file when a diff opens in the background, and says nothing for a foreground open', () => {
    expect(diffOpenAnnouncement('src/a.ts', true)).toBe('Opened diff of a.ts in the background')
    expect(diffOpenAnnouncement('src/a.ts', false)).toBeUndefined()
  })
})

const key = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean }> = {}) => enterActivation({ key: 'Enter', ctrlKey: false, metaKey: false, ...over })

describe('enterActivation', () => {
  it('treats plain Enter as a keyboard activation with no modifiers', () => {
    expect(key()).toEqual({ keyboard: true, ctrlKey: false, metaKey: false })
  })

  it('carries Ctrl and Cmd so Ctrl+Enter and Cmd+Enter open in the background', () => {
    expect(key({ ctrlKey: true })).toEqual({ keyboard: true, ctrlKey: true, metaKey: false })
    expect(key({ metaKey: true })).toEqual({ keyboard: true, ctrlKey: false, metaKey: true })
  })

  it('ignores every other key, so Space keeps its native click', () => {
    expect(key({ key: ' ' })).toBeNull()
    expect(key({ key: 'Tab' })).toBeNull()
  })
})

describe('openDiffFromRow from the keyboard', () => {
  const tabIds = () => useDocumentTabsStore.getState().bySession.s1?.tabs.map((tab) => tab.id) ?? []
  const activation = (over: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) => enterActivation({ key: 'Enter', ctrlKey: false, metaKey: false, ...over })!

  beforeEach(() => {
    announce.mockReset()
    focusExistingDocumentTab.mockReset()
    useDocumentTabsStore.setState({ bySession: {} })
    useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0 })
    useRightPaneStore.setState({ open: true, openPanelIds: ['git-changes'], activePanelId: 'git-changes', suppressNextContentFocus: false })
  })

  it('opens the diff tab in the foreground on Enter', () => {
    openDiffFromRow('s1', 'changes', 'a.ts', activation())
    expect(tabIds()).toEqual(['diff:changes:a.ts'])
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 's1', id: 'diff:changes:a.ts' })
    expect(useRightPaneStore.getState().suppressNextContentFocus).toBe(false)
  })

  it('opens the diff tab in the background on Ctrl+Enter, leaving the panel and focus on the row', () => {
    openDiffFromRow('s1', 'changes', 'a.ts', activation({ ctrlKey: true }))
    expect(tabIds()).toEqual(['diff:changes:a.ts'])
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'git-changes' })
    expect(announce).toHaveBeenCalledWith('Opened diff of a.ts in the background')
    expect(focusExistingDocumentTab).not.toHaveBeenCalled()
  })

  it('focuses an already open diff tab on Enter but not on Ctrl+Enter', () => {
    openDiffFromRow('s1', 'changes', 'a.ts', activation({ ctrlKey: true }))
    openDiffFromRow('s1', 'changes', 'a.ts', activation({ ctrlKey: true }))
    expect(focusExistingDocumentTab).not.toHaveBeenCalled()
    openDiffFromRow('s1', 'changes', 'a.ts', activation())
    expect(focusExistingDocumentTab).toHaveBeenCalledWith('s1', 'diff:changes:a.ts')
  })
})
