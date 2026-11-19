import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTabsStore } from './document-tabs-store'
import { resolveActiveTab, RIGHT_PANE_SANITY_MAX_WIDTH_PX, useRightPaneStore } from './right-pane-store'

const pane = () => useRightPaneStore.getState()
const docs = () => useDocumentTabsStore.getState()
const openFile = (path: string) => docs().openDocumentTab('s1', { kind: 'file', path }, { activate: true })

beforeEach(() => {
  useDocumentTabsStore.setState({ bySession: {} })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, activeTabKey: null, chatCollapsed: false })
})

describe('activateTab', () => {
  it('selecting a document tab sets that Session\'s active document id and the live key', () => {
    pane().openPanel('git-changes')
    const { id } = openFile('a.ts')
    docs().setActiveDocument('s1', null)
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    expect(docs().bySession['s1']?.activeId).toBe(id)
    expect(pane().activeTabKey).toEqual({ kind: 'document', sessionId: 's1', id })
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
    expect(pane().activeTabKey).toEqual({ kind: 'panel', id: 'git-changes' })
    expect(pane().activePanelId).toBe('git-changes')
  })

  it('ignores a document tab the Session does not hold and a panel that is not open', () => {
    pane().openPanel('git-changes')
    pane().activateTab({ kind: 'document', sessionId: 's1', id: 'file:missing.ts' })
    pane().activateTab({ kind: 'panel', id: 'outline' })
    expect(pane().activeTabKey).toEqual({ kind: 'panel', id: 'git-changes' })
    expect(pane().activePanelId).toBe('git-changes')
  })

  it('opening a panel drops the selected document tab of the Session it was selected in', () => {
    const { id } = openFile('a.ts')
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    pane().openPanel('outline')
    expect(docs().bySession['s1']?.activeId).toBeNull()
    expect(pane().activeTabKey).toEqual({ kind: 'panel', id: 'outline' })
  })

  it('keeps a selected document tab when a panel behind it closes', () => {
    pane().openPanel('git-changes')
    pane().openPanel('outline')
    const { id } = openFile('a.ts')
    pane().activateTab({ kind: 'document', sessionId: 's1', id })
    pane().closePanel('outline')
    expect(pane().activeTabKey).toEqual({ kind: 'document', sessionId: 's1', id })
    expect(pane().activePanelId).toBe('git-changes')
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
