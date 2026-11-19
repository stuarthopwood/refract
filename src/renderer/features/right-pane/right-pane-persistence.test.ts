import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RIGHT_PANE, MAX_DOCUMENT_PATH_BYTES, MAX_DOCUMENT_TABS_PER_SESSION, type RightPaneSettings } from '../../../shared/rightPane'
import { useDocumentTabsStore } from '../../state/document-tabs-store'
import { RIGHT_PANE_MIN_WIDTH_PX, RIGHT_PANE_SANITY_MAX_WIDTH_PX, useRightPaneStore } from '../../state/right-pane-store'
import { restoreRightPane, snapshotRightPane, validateDocumentTabs } from './right-pane-persistence'

// The real registry pulls in `@/state` (a dev-only `window` hook), which the node environment lacks.
vi.mock('./panel-registry', () => ({
  HOSTED_PANELS: ['git-changes', 'file-explorer', 'outline'].map((id) => ({ id })),
  isPinnedPanelId: (id: string) => id === 'pull-request' || id === 'issue'
}))

const saved = (over: Partial<RightPaneSettings> = {}): RightPaneSettings => ({ ...DEFAULT_RIGHT_PANE, open: true, ...over })
const file = (path: string) => ({ kind: 'file', path })

beforeEach(() => {
  useDocumentTabsStore.setState({ bySession: {} })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, panelOrder: [], chatCollapsed: false })
})

describe('validateDocumentTabs', () => {
  it('keeps a valid file tab and a valid diff tab with their active id and recency', () => {
    const restored = validateDocumentTabs({
      s1: { tabs: [file('a.ts'), { kind: 'diff', group: 'staged', path: 'src/b.ts' }], activeId: 'diff:staged:src/b.ts', recency: ['file:a.ts', 'diff:staged:src/b.ts'] }
    })
    expect(restored['s1']).toEqual({
      tabs: [{ kind: 'file', path: 'a.ts' }, { kind: 'diff', group: 'staged', path: 'src/b.ts' }],
      activeId: 'diff:staged:src/b.ts',
      recency: ['file:a.ts', 'diff:staged:src/b.ts']
    })
  })

  it.each([
    ['an unknown kind', { kind: 'folder', path: 'a' }],
    ['a diff with no group', { kind: 'diff', path: 'a.ts' }],
    ['a diff with an unknown group', { kind: 'diff', group: 'stashed', path: 'a.ts' }],
    ['a file with a group', { kind: 'file', group: 'staged', path: 'a.ts' }],
    ['an absolute path', file('/etc/passwd')],
    ['a drive path', file('C:/x.ts')],
    ['a parent-escaping path', file('../x.ts')],
    ['a backslash path', file('a\\b.ts')],
    ['an empty path', file('')],
    ['a path over the byte bound', file('a'.repeat(MAX_DOCUMENT_PATH_BYTES + 1))],
    ['a non-object', 'a.ts']
  ])('drops %s', (_name, tab) => {
    expect(validateDocumentTabs({ s1: { tabs: [tab, file('ok.ts')], activeId: null, recency: [] } })['s1']?.tabs).toEqual([{ kind: 'file', path: 'ok.ts' }])
  })

  it('bounds a path by bytes, not characters', () => {
    const multibyte = 'é'.repeat(MAX_DOCUMENT_PATH_BYTES / 2 + 1)
    expect(multibyte.length).toBeLessThanOrEqual(MAX_DOCUMENT_PATH_BYTES)
    expect(validateDocumentTabs({ s1: { tabs: [file(multibyte)], activeId: null, recency: [] } })).toEqual({})
    expect(validateDocumentTabs({ s1: { tabs: [file('é'.repeat(MAX_DOCUMENT_PATH_BYTES / 2))], activeId: null, recency: [] } })['s1']).toBeDefined()
  })

  it('collapses duplicate identities to one tab', () => {
    expect(validateDocumentTabs({ s1: { tabs: [file('a.ts'), file('a.ts')], activeId: null, recency: [] } })['s1']?.tabs).toHaveLength(1)
  })

  it('drops a Session holding more than the per-Session cap, whole', () => {
    const tabs = Array.from({ length: MAX_DOCUMENT_TABS_PER_SESSION + 1 }, (_unused, index) => file(`f${index}.ts`))
    const atCap = tabs.slice(0, MAX_DOCUMENT_TABS_PER_SESSION)
    const restored = validateDocumentTabs({ over: { tabs, activeId: null, recency: [] }, ok: { tabs: atCap, activeId: null, recency: [] } })
    expect(restored['over']).toBeUndefined()
    expect(restored['ok']?.tabs).toHaveLength(MAX_DOCUMENT_TABS_PER_SESSION)
  })

  it('repairs an active id or recency entry that names no tab, and drops a Session left with no tab', () => {
    const restored = validateDocumentTabs({
      s1: { tabs: [file('a.ts')], activeId: 'file:gone.ts', recency: ['file:gone.ts', 'file:a.ts', 'file:a.ts'] },
      empty: { tabs: [{ kind: 'nope', path: 'x' }], activeId: null, recency: [] },
      '': { tabs: [file('a.ts')], activeId: null, recency: [] }
    })
    expect(restored['s1']).toEqual({ tabs: [{ kind: 'file', path: 'a.ts' }], activeId: null, recency: ['file:a.ts'] })
    expect(Object.keys(restored)).toEqual(['s1'])
  })

  it.each([[null], [undefined], [[]], ['x'], [3]])('returns nothing for a non-record %j', (raw) => {
    expect(validateDocumentTabs(raw)).toEqual({})
  })
})

describe('restoreRightPane and snapshotRightPane', () => {
  it('round-trips document tabs and the collapsed chat', () => {
    const row = saved({
      openPanelIds: ['git-changes'],
      activePanelId: 'git-changes',
      chatCollapsed: true,
      documentTabs: { s1: { tabs: [file('a.ts') as never], activeId: 'file:a.ts', recency: ['file:a.ts'] } }
    })
    restoreRightPane(row)
    expect(snapshotRightPane()).toEqual(row)
  })

  it('normalises a closed pane with a collapsed chat so the chat shows', () => {
    restoreRightPane(saved({ open: false, chatCollapsed: true }))
    expect(useRightPaneStore.getState().chatCollapsed).toBe(false)
    expect(snapshotRightPane().chatCollapsed).toBe(false)
  })

  it('keeps a width beyond the old 520 cap and clamps to the sanity range', () => {
    restoreRightPane(saved({ widthPx: 900 }))
    expect(useRightPaneStore.getState().widthPx).toBe(900)
    restoreRightPane(saved({ widthPx: 99999 }))
    expect(useRightPaneStore.getState().widthPx).toBe(RIGHT_PANE_SANITY_MAX_WIDTH_PX)
    restoreRightPane(saved({ widthPx: 1 }))
    expect(useRightPaneStore.getState().widthPx).toBe(RIGHT_PANE_MIN_WIDTH_PX)
  })

  it('restores the default row when nothing was saved', () => {
    restoreRightPane(undefined)
    expect(snapshotRightPane()).toEqual(DEFAULT_RIGHT_PANE)
  })

  it('drops invalid tabs on restore and never writes them back', () => {
    restoreRightPane(saved({ documentTabs: { s1: { tabs: [file('/abs') as never], activeId: null, recency: [] } } }))
    expect(useDocumentTabsStore.getState().bySession).toEqual({})
    expect(snapshotRightPane().documentTabs).toEqual({})
  })

  it('omits a Session whose tabs were all closed', () => {
    restoreRightPane(saved({ documentTabs: { s1: { tabs: [file('a.ts') as never], activeId: null, recency: [] } } }))
    useDocumentTabsStore.getState().closeAllDocuments('s1')
    expect(snapshotRightPane().documentTabs).toEqual({})
  })
})

describe('pruneSessions (the init-stores restore guard)', () => {
  it('keeps listed Sessions, drops unlisted ones', () => {
    restoreRightPane(
      saved({
        documentTabs: {
          keep: { tabs: [file('a.ts') as never], activeId: null, recency: [] },
          gone: { tabs: [file('b.ts') as never], activeId: null, recency: [] }
        }
      })
    )
    useDocumentTabsStore.getState().pruneSessions(new Set(['keep']))
    expect(Object.keys(snapshotRightPane().documentTabs)).toEqual(['keep'])
  })
})
