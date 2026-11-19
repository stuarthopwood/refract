import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { gitEntry } from '../right-pane/git-changes/git-changes-test-fixtures'
import { gitSnapshot as snapshot } from './documents-test-fixtures'
import { planDeadMarks, syncDiffTabLiveness } from './diff-liveness'

const tab = (id: string, dead = false) => ({ id, dead, kind: 'diff' as const, group: 'changes' as const, path: id.replace('diff:changes:', '') })
const opened = () => useDocumentTabsStore.getState().bySession.s1?.tabs ?? []

beforeEach(() => {
  useDocumentTabsStore.setState({ bySession: {} })
})

describe('planDeadMarks', () => {
  it('marks a diff tab dead once no group holds its file', () => {
    expect(planDeadMarks([tab('diff:changes:a.ts')], snapshot({ changes: [gitEntry('b.ts')] }))).toEqual([{ id: 'diff:changes:a.ts', dead: true }])
  })

  it('leaves a tab alone while another group holds its file, because it is being retargeted', () => {
    expect(planDeadMarks([tab('diff:changes:a.ts')], snapshot({ staged: [gitEntry('a.ts')] }))).toEqual([])
  })

  it('revives a dead tab when its file is changed again', () => {
    expect(planDeadMarks([tab('diff:changes:a.ts', true)], snapshot({ changes: [gitEntry('a.ts')] }))).toEqual([{ id: 'diff:changes:a.ts', dead: false }])
  })

  it('marks nothing before the snapshot has loaded', () => {
    expect(planDeadMarks([tab('diff:changes:a.ts')], null)).toEqual([])
  })

  it('ignores file tabs', () => {
    expect(planDeadMarks([{ id: 'file:a.ts', dead: false, kind: 'file', path: 'a.ts' }], snapshot({}))).toEqual([])
  })
})

describe('syncDiffTabLiveness', () => {
  it('marks every open diff tab, not only the active one', () => {
    const store = useDocumentTabsStore.getState()
    store.openDocumentTab('s1', { kind: 'diff', group: 'changes', path: 'a.ts' }, { activate: true })
    store.openDocumentTab('s1', { kind: 'diff', group: 'changes', path: 'b.ts' }, { activate: false })
    store.openDocumentTab('s1', { kind: 'file', path: 'c.ts' }, { activate: false })
    syncDiffTabLiveness('s1', snapshot({ changes: [gitEntry('b.ts')] }))
    expect(opened().map((t) => [t.id, t.dead])).toEqual([
      ['diff:changes:a.ts', true],
      ['diff:changes:b.ts', false],
      ['file:c.ts', false]
    ])
  })
})
