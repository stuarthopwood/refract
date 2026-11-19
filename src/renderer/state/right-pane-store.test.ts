import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTabsStore } from './document-tabs-store'
import { frontActiveTab, resolveActiveTab, RIGHT_PANE_SANITY_MAX_WIDTH_PX, useRightPaneStore } from './right-pane-store'
import { useSplitStore } from './split-store'

const pane = () => useRightPaneStore.getState()
const docs = () => useDocumentTabsStore.getState()
const openFile = (path: string, sessionId = 's1') => docs().openDocumentTab(sessionId, { kind: 'file', path }, { activate: true })

beforeEach(() => {
  useDocumentTabsStore.setState({ bySession: {} })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0 })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, chatCollapsed: false })
})

describe('activateTab', () => {
  it('selecting a document tab sets that Session\'s active document id and the front tab', () => {
    pane().openPanel('git-changes')
    const { id } = openFile('a.ts')
    docs().setActiveDocument('s1', null)
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    expect(docs().bySession['s1']?.activeId).toBe(id)
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 's1', id })
    // The panel half of the union survives, so closing the document tab can fall back to it.
    expect(pane().activePanelId).toBe('git-changes')
  })

  it('selecting a panel tab clears the document selection of the named Session', () => {
    pane().openPanel('git-changes')
    pane().openPanel('file-explorer')
    const { id } = openFile('a.ts')
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    pane().activateTab({ kind: 'panel', id: 'git-changes' }, 's1')
    expect(docs().bySession['s1']?.activeId).toBeNull()
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'git-changes' })
    expect(pane().activePanelId).toBe('git-changes')
  })

  it('ignores a document tab the Session does not hold and a panel that is not open', () => {
    pane().openPanel('git-changes')
    pane().activateTab({ kind: 'document', sessionId: 's1', id: 'file:missing.ts' })
    pane().activateTab({ kind: 'panel', id: 'outline' })
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'git-changes' })
    expect(pane().activePanelId).toBe('git-changes')
  })

  it('opening a panel drops the selected document tab of the front Session', () => {
    const { id } = openFile('a.ts')
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    pane().openPanel('outline')
    expect(docs().bySession['s1']?.activeId).toBeNull()
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'outline' })
  })

  it('after a Session switch, opening a panel clears the new front Session, not the previous one', () => {
    const a = openFile('a.ts', 'sA')
    const b = openFile('b.ts', 'sB')
    useSplitStore.setState({ paneSessionIds: ['sA'], focusedIndex: 0 })
    pane().activateTab({ kind: 'document', sessionId: 'sA', id: a.id })
    useSplitStore.setState({ paneSessionIds: ['sB'], focusedIndex: 0 })
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 'sB', id: b.id })
    pane().openPanel('outline')
    expect(docs().bySession['sB']?.activeId).toBeNull()
    expect(docs().bySession['sA']?.activeId).toBe(a.id)
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'outline' })
  })

  it('the front tab follows the front Session as the split focus moves', () => {
    pane().openPanel('file-explorer')
    const b = openFile('b.ts', 'sB')
    useSplitStore.setState({ paneSessionIds: ['sA', 'sB'], focusedIndex: 0 })
    expect(frontActiveTab()).toEqual({ kind: 'panel', id: 'file-explorer' })
    useSplitStore.setState({ focusedIndex: 1 })
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 'sB', id: b.id })
  })

  it('keeps a selected document tab when a panel behind it closes', () => {
    pane().openPanel('git-changes')
    pane().openPanel('outline')
    const { id } = openFile('a.ts')
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    pane().closePanel('outline')
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 's1', id })
    expect(pane().activePanelId).toBe('git-changes')
  })
})

describe('restore', () => {
  it('reports the front Session\'s persisted document tab, not the panel', () => {
    const { id } = openFile('a.ts')
    pane().restore({ open: true, widthPx: 320, openPanelIds: ['outline'], activePanelId: 'outline', panelOrder: [], chatCollapsed: false })
    expect(docs().bySession['s1']?.activeId).toBe(id)
    expect(frontActiveTab()).toEqual({ kind: 'document', sessionId: 's1', id })
  })
})

describe('resolveActiveTab', () => {
  it('prefers the Session\'s live document tab, else the last active panel, else none', () => {
    const { id } = openFile('a.ts')
    const documents = docs().bySession['s1']
    expect(resolveActiveTab('s1', 'outline', documents)).toEqual({ kind: 'document', sessionId: 's1', id })
    expect(resolveActiveTab('s2', 'outline', docs().bySession['s2'])).toEqual({ kind: 'panel', id: 'outline' })
    expect(resolveActiveTab(null, null, documents)).toBeNull()
  })

  it('never returns a stale document id', () => {
    expect(resolveActiveTab('s1', 'outline', { tabs: [], activeId: 'file:gone.ts' })).toEqual({ kind: 'panel', id: 'outline' })
  })
})

describe('chat collapse', () => {
  it('hiding the chat opens the pane', () => {
    pane().setChatCollapsed(true)
    expect(pane().open).toBe(true)
    expect(pane().chatCollapsed).toBe(true)
  })

  it('closing the pane shows the chat again, so both are never hidden', () => {
    pane().setChatCollapsed(true)
    pane().toggleCollapsed()
    expect(pane().open).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('syncRenderedState with a closed pane also clears chatCollapsed', () => {
    pane().setChatCollapsed(true)
    pane().syncRenderedState(false, 320)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('restore normalises a saved closed pane with a collapsed chat to a shown chat', () => {
    pane().restore({ open: false, widthPx: 320, openPanelIds: [], activePanelId: null, panelOrder: [], chatCollapsed: true })
    expect(pane().chatCollapsed).toBe(false)
    pane().restore({ open: true, widthPx: 320, openPanelIds: [], activePanelId: null, panelOrder: [], chatCollapsed: true })
    expect(pane().chatCollapsed).toBe(true)
  })
})

describe('width ceiling', () => {
  it('matches the Rust sanity ceiling in right_pane.rs', () => {
    expect(RIGHT_PANE_SANITY_MAX_WIDTH_PX).toBe(4096)
  })
})
