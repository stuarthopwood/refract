import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_DOCUMENT_TABS_PER_SESSION } from '../../shared/rightPane'
import { documentTabDomId, documentTabId, EMPTY_SESSION_DOCUMENTS, nextAfterClose, pickEviction, useDocumentTabsStore, type DocumentTab, type TabKey } from './document-tabs-store'

const file = (path: string) => ({ kind: 'file' as const, path })
const diff = (path: string, group: 'staged' | 'changes' = 'changes') => ({ kind: 'diff' as const, group, path })
const store = () => useDocumentTabsStore.getState()
const session = (sessionId = 's1') => store().bySession[sessionId] ?? EMPTY_SESSION_DOCUMENTS
const ids = (sessionId = 's1') => session(sessionId).tabs.map((tab) => tab.id)
const open = (path: string, activate = true, openedFrom?: TabKey) => store().openDocumentTab('s1', file(path), { activate, openedFrom })
const docKey = (id: string): TabKey => ({ kind: 'document', sessionId: 's1', id })

beforeEach(() => useDocumentTabsStore.setState({ bySession: {} }))

describe('identity', () => {
  it('keys a file by path and a diff by group and path, so the same path never collides across kinds', () => {
    expect(documentTabId(file('a.ts'))).toBe('file:a.ts')
    expect(documentTabId(diff('a.ts', 'staged'))).toBe('diff:staged:a.ts')
    expect(new Set([documentTabId(file('a.ts')), documentTabId(diff('a.ts', 'staged')), documentTabId(diff('a.ts', 'changes'))]).size).toBe(3)
  })

  it('derives a stable DOM id with no spaces for aria-controls', () => {
    const id = documentTabDomId('file:my dir/a b.ts')
    expect(id).toBe(documentTabDomId('file:my dir/a b.ts'))
    expect(id).toMatch(/^doc-tab-[0-9a-z]+$/)
    expect(id).not.toBe(documentTabDomId('file:my dir/a c.ts'))
  })
})

describe('openDocumentTab', () => {
  it('opens and activates a new tab', () => {
    expect(open('a.ts')).toEqual({ id: 'file:a.ts', evicted: null })
    expect(ids()).toEqual(['file:a.ts'])
    expect(session().activeId).toBe('file:a.ts')
  })

  it('never duplicates an identity and re-activates the existing tab', () => {
    open('a.ts')
    open('b.ts')
    open('a.ts')
    expect(ids()).toEqual(['file:a.ts', 'file:b.ts'])
    expect(session().activeId).toBe('file:a.ts')
  })

  it('leaves the active tab alone on a background open, even of an existing tab', () => {
    open('a.ts')
    open('b.ts', false)
    open('a.ts', false)
    expect(ids()).toEqual(['file:a.ts', 'file:b.ts'])
    expect(session().activeId).toBe('file:a.ts')
  })

  it('keeps tabs per Session', () => {
    open('a.ts')
    store().openDocumentTab('s2', file('b.ts'), { activate: true })
    expect(ids('s1')).toEqual(['file:a.ts'])
    expect(ids('s2')).toEqual(['file:b.ts'])
  })
})

describe('closing a tab', () => {
  it('returns to the tab that was active when it opened, then the neighbour', () => {
    open('a.ts')
    open('b.ts', true, docKey('file:a.ts'))
    open('c.ts', true, docKey('file:b.ts'))
    store().setActiveDocument('s1', 'file:b.ts')
    expect(store().closeDocumentTab('s1', 'file:b.ts')).toMatchObject({ activeChanged: true, next: docKey('file:a.ts') })
    expect(session().activeId).toBe('file:a.ts')
  })

  it('returns to the opening panel tab and clears the document selection', () => {
    open('a.ts', true, { kind: 'panel', id: 'git-changes' })
    const result = store().closeDocumentTab('s1', 'file:a.ts')
    expect(result).toMatchObject({ activeChanged: true, next: { kind: 'panel', id: 'git-changes' } })
    expect(session().activeId).toBeNull()
  })

  it('falls back to the right neighbour, else the left, when the opener is gone', () => {
    open('a.ts')
    open('b.ts')
    open('c.ts')
    store().setActiveDocument('s1', 'file:b.ts')
    expect(store().closeDocumentTab('s1', 'file:b.ts').next).toEqual(docKey('file:c.ts'))
    expect(store().closeDocumentTab('s1', 'file:c.ts').next).toEqual(docKey('file:a.ts'))
  })

  it('reports no next tab when the last one closes', () => {
    open('a.ts')
    expect(store().closeDocumentTab('s1', 'file:a.ts')).toMatchObject({ activeChanged: true, next: null })
    expect(session().activeId).toBeNull()
  })

  it('leaves the selection alone when a background tab closes', () => {
    open('a.ts')
    open('b.ts', false)
    expect(store().closeDocumentTab('s1', 'file:b.ts')).toMatchObject({ activeChanged: false, next: null })
    expect(session().activeId).toBe('file:a.ts')
  })

  it('ignores an unknown id', () => {
    open('a.ts')
    expect(store().closeDocumentTab('s1', 'file:nope.ts').closed).toEqual([])
    expect(ids()).toEqual(['file:a.ts'])
  })

  it('forgets an opener that was itself closed', () => {
    open('a.ts')
    open('b.ts', true, docKey('file:a.ts'))
    open('c.ts')
    store().closeDocumentTab('s1', 'file:a.ts')
    store().setActiveDocument('s1', 'file:b.ts')
    expect(store().closeDocumentTab('s1', 'file:b.ts').next).toEqual(docKey('file:c.ts'))
  })
})

describe('eviction', () => {
  const tabs = (specs: Array<[string, boolean]>): DocumentTab[] => specs.map(([path, dead]) => ({ ...file(path), id: `file:${path}`, dead }))

  it('picks a dead tab before a more recent live one, then the least recent', () => {
    const list = tabs([['a', false], ['b', true], ['c', false]])
    expect(pickEviction(list, ['file:a', 'file:b', 'file:c'], null)).toBe('file:b')
    expect(pickEviction(tabs([['a', false], ['b', false]]), ['file:b', 'file:a'], null)).toBe('file:b')
  })

  it('never picks the protected tab, even when it is the dead or least recent one', () => {
    const list = tabs([['a', true], ['b', false]])
    expect(pickEviction(list, ['file:a', 'file:b'], 'file:a')).toBe('file:b')
  })

  it('evicts the least recently active tab on the 21st open and reports it', () => {
    for (let i = 0; i < MAX_DOCUMENT_TABS_PER_SESSION; i++) open(`f${i}.ts`, false)
    store().setActiveDocument('s1', 'file:f0.ts')
    const result = open('extra.ts')
    expect(result.evicted?.id).toBe('file:f1.ts')
    expect(session().tabs).toHaveLength(MAX_DOCUMENT_TABS_PER_SESSION)
    expect(ids()).toContain('file:extra.ts')
    expect(ids()).toContain('file:f0.ts')
  })

  it('evicts a dead tab first on a background open and never the active tab', () => {
    for (let i = 0; i < MAX_DOCUMENT_TABS_PER_SESSION; i++) open(`f${i}.ts`, i === 0)
    store().markDead('s1', 'file:f5.ts', true)
    expect(open('extra.ts', false).evicted?.id).toBe('file:f5.ts')
    expect(session().activeId).toBe('file:f0.ts')
  })

  it('drops the evicted tab from recency, view state and opener records', () => {
    for (let i = 0; i < MAX_DOCUMENT_TABS_PER_SESSION; i++) open(`f${i}.ts`, false)
    store().setViewState('s1', 'file:f0.ts', { wrap: true })
    store().setActiveDocument('s1', 'file:f1.ts')
    open('extra.ts')
    expect(session().recency).not.toContain('file:f0.ts')
    expect(session().view['file:f0.ts']).toBeUndefined()
  })
})

describe('retargetDiff', () => {
  it('moves a diff tab to its new group in place, keeping position and selection', () => {
    store().openDocumentTab('s1', diff('a.ts', 'changes'), { activate: true })
    open('b.ts')
    store().setActiveDocument('s1', 'diff:changes:a.ts')
    expect(store().retargetDiff('s1', 'diff:changes:a.ts', 'staged')).toEqual({ id: 'diff:staged:a.ts', merged: false })
    expect(ids()).toEqual(['diff:staged:a.ts', 'file:b.ts'])
    expect(session().activeId).toBe('diff:staged:a.ts')
    expect(session().recency).toContain('diff:staged:a.ts')
  })

  it('drops the moved tab when its new identity is already open, and keeps the selection on the survivor', () => {
    store().openDocumentTab('s1', diff('a.ts', 'changes'), { activate: false })
    store().openDocumentTab('s1', diff('a.ts', 'staged'), { activate: false })
    store().setActiveDocument('s1', 'diff:changes:a.ts')
    expect(store().retargetDiff('s1', 'diff:changes:a.ts', 'staged')).toEqual({ id: 'diff:staged:a.ts', merged: true })
    expect(ids()).toEqual(['diff:staged:a.ts'])
    expect(session().activeId).toBe('diff:staged:a.ts')
  })

  it('ignores a file tab, an unknown tab and an unchanged group', () => {
    open('a.ts')
    store().openDocumentTab('s1', diff('b.ts'), { activate: false })
    expect(store().retargetDiff('s1', 'file:a.ts', 'staged')).toBeNull()
    expect(store().retargetDiff('s1', 'diff:changes:zzz', 'staged')).toBeNull()
    expect(store().retargetDiff('s1', 'diff:changes:b.ts', 'changes')).toBeNull()
  })
})

describe('markDead', () => {
  it('flags and clears a tab, and does not touch state when nothing changes', () => {
    open('a.ts')
    store().markDead('s1', 'file:a.ts', true)
    expect(session().tabs[0]?.dead).toBe(true)
    const before = store().bySession
    store().markDead('s1', 'file:a.ts', true)
    expect(store().bySession).toBe(before)
    store().markDead('s1', 'file:a.ts', false)
    expect(session().tabs[0]?.dead).toBe(false)
  })
})

describe('bulk close', () => {
  it('closeOthers keeps one tab, selects it and counts the rest', () => {
    open('a.ts')
    open('b.ts')
    open('c.ts')
    const result = store().closeOthers('s1', 'file:a.ts')
    expect(result.closed.map((tab) => tab.id)).toEqual(['file:b.ts', 'file:c.ts'])
    expect(result).toMatchObject({ activeChanged: true, next: docKey('file:a.ts') })
    expect(ids()).toEqual(['file:a.ts'])
    expect(session().activeId).toBe('file:a.ts')
  })

  it('closeOthers reports no selection change when the kept tab was already active', () => {
    open('a.ts')
    open('b.ts')
    expect(store().closeOthers('s1', 'file:b.ts')).toMatchObject({ activeChanged: false, next: null })
  })

  it('closeAllDocuments empties the Session and hands the selection back', () => {
    open('a.ts')
    open('b.ts')
    const result = store().closeAllDocuments('s1')
    expect(result).toMatchObject({ activeChanged: true, next: null })
    expect(result.closed).toHaveLength(2)
    expect(session()).toMatchObject({ tabs: [], activeId: null })
  })

  it('closeDead closes only dead tabs and moves an active dead tab to a live neighbour', () => {
    open('a.ts')
    open('b.ts')
    open('c.ts')
    store().markDead('s1', 'file:b.ts', true)
    store().setActiveDocument('s1', 'file:b.ts')
    const result = store().closeDead('s1')
    expect(result.closed.map((tab) => tab.id)).toEqual(['file:b.ts'])
    expect(result.next).toEqual(docKey('file:c.ts'))
    expect(ids()).toEqual(['file:a.ts', 'file:c.ts'])
    expect(session().activeId).toBe('file:c.ts')
  })

  it('closeDead with no dead tab changes nothing', () => {
    open('a.ts')
    const before = store().bySession
    expect(store().closeDead('s1').closed).toEqual([])
    expect(store().bySession).toBe(before)
  })
})

describe('nextAfterClose', () => {
  it('skips a neighbour that is closing too', () => {
    const tabs: DocumentTab[] = ['a', 'b', 'c'].map((path) => ({ ...file(path), id: `file:${path}`, dead: false }))
    expect(nextAfterClose(tabs, new Set(['file:b', 'file:c']), 'file:b', {}, 's1')).toEqual(docKey('file:a'))
  })
})

describe('setActiveDocument and view state', () => {
  it('selects an existing tab, bumps its recency and ignores an unknown one', () => {
    open('a.ts')
    open('b.ts')
    store().setActiveDocument('s1', 'file:a.ts')
    expect(session().recency).toEqual(['file:b.ts', 'file:a.ts'])
    store().setActiveDocument('s1', 'file:nope.ts')
    expect(session().activeId).toBe('file:a.ts')
    store().setActiveDocument('s1', null)
    expect(session().activeId).toBeNull()
  })

  it('merges view state per tab and refuses an unknown tab', () => {
    open('a.ts')
    store().setViewState('s1', 'file:a.ts', { wrap: false })
    store().setViewState('s1', 'file:a.ts', { scrollTop: 120 })
    store().setViewState('s1', 'file:nope.ts', { wrap: true })
    expect(session().view).toEqual({ 'file:a.ts': { wrap: false, scrollTop: 120 } })
  })
})

describe('restore, dropSession and pruneSessions', () => {
  it('rebuilds tabs from validated input as live, with no view state', () => {
    store().restore({ s1: { tabs: [file('a.ts'), diff('b.ts', 'staged')], activeId: 'diff:staged:b.ts', recency: ['file:a.ts', 'diff:staged:b.ts'] } })
    expect(session().tabs).toEqual([
      { kind: 'file', path: 'a.ts', id: 'file:a.ts', dead: false },
      { kind: 'diff', group: 'staged', path: 'b.ts', id: 'diff:staged:b.ts', dead: false }
    ])
    expect(session()).toMatchObject({ activeId: 'diff:staged:b.ts', openedFrom: {}, view: {} })
  })

  it('dropSession removes one Session and leaves the others', () => {
    open('a.ts')
    store().openDocumentTab('s2', file('b.ts'), { activate: true })
    store().dropSession('s1')
    expect(Object.keys(store().bySession)).toEqual(['s2'])
  })

  it('pruneSessions keeps only the listed Sessions and keeps the state object when nothing goes', () => {
    open('a.ts')
    store().openDocumentTab('s2', file('b.ts'), { activate: true })
    const before = store().bySession
    store().pruneSessions(new Set(['s1', 's2']))
    expect(store().bySession).toBe(before)
    store().pruneSessions(new Set(['s2']))
    expect(Object.keys(store().bySession)).toEqual(['s2'])
  })
})
