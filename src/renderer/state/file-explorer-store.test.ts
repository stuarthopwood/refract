import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import type { FilePreview } from '../../shared/model'
import { useDocumentTabsStore } from './document-tabs-store'
import { useFileExplorerStore } from './file-explorer-store'

const textPreview = (path: string, content: string): FilePreview => ({ path, kind: 'text', content })
const entryOf = (sessionId: string, path: string) => useFileExplorerStore.getState().previews[sessionId]?.[path]
const openFileTab = (sessionId: string, path: string) =>
  useDocumentTabsStore.getState().openDocumentTab(sessionId, { kind: 'file', path }, { activate: false })

/** A readPreview whose answers the test releases one at a time, to order overlapping loads. */
function deferredReads() {
  const pending: Array<(preview: FilePreview) => void> = []
  // The tsconfig lib predates Promise.withResolvers, so the executor form is the only one that compiles.
  const readPreview = vi.fn(
    (_sessionId: string, path: string) =>
      new Promise((resolve) => {
        pending.push((preview) => resolve({ ok: true, value: { preview: { ...preview, path } } }))
      })
  )
  const getStatus = vi.fn(async () => ({ ok: true, value: { status: null } }))
  vi.stubGlobal('window', { refract: { fileExplorer: { readPreview, getStatus } } })
  return { pending }
}

beforeEach(() => {
  vi.useFakeTimers()
  toastError.mockReset()
  useFileExplorerStore.setState({ bySession: {}, previews: {} })
  useDocumentTabsStore.setState({ bySession: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('file previews keyed by Session and path', () => {
  it('keeps one preview per path, so two file tabs do not share one', async () => {
    const { pending } = deferredReads()
    const first = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    const second = useFileExplorerStore.getState().loadPreview('s1', 'b.ts')
    pending[0]!(textPreview('a.ts', 'A'))
    pending[1]!(textPreview('b.ts', 'B'))
    await Promise.all([first, second])
    expect(entryOf('s1', 'a.ts')?.preview?.content).toBe('A')
    expect(entryOf('s1', 'b.ts')?.preview?.content).toBe('B')
  })

  it('keeps the same path in two Sessions apart', async () => {
    const { pending } = deferredReads()
    const first = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    const second = useFileExplorerStore.getState().loadPreview('s2', 'a.ts')
    pending[0]!(textPreview('a.ts', 'one'))
    pending[1]!(textPreview('a.ts', 'two'))
    await Promise.all([first, second])
    expect(entryOf('s1', 'a.ts')?.preview?.content).toBe('one')
    expect(entryOf('s2', 'a.ts')?.preview?.content).toBe('two')
  })

  it('drops a superseded load for the same path and keeps the newer answer', async () => {
    const { pending } = deferredReads()
    const stale = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    const fresh = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    pending[1]!(textPreview('a.ts', 'new'))
    await fresh
    pending[0]!(textPreview('a.ts', 'old'))
    await stale
    expect(entryOf('s1', 'a.ts')).toEqual({ preview: textPreview('a.ts', 'new'), loading: false })
  })

  it('keeps the last preview on screen while a refresh loads', async () => {
    const { pending } = deferredReads()
    const first = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    pending[0]!(textPreview('a.ts', 'v1'))
    await first
    const refresh = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    expect(entryOf('s1', 'a.ts')).toEqual({ preview: textPreview('a.ts', 'v1'), loading: true })
    pending[1]!(textPreview('a.ts', 'v2'))
    await refresh
  })

  it('discards a load that finishes after the path was cleared', async () => {
    const { pending } = deferredReads()
    const load = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    useFileExplorerStore.getState().clearPreview('s1', 'a.ts')
    pending[0]!(textPreview('a.ts', 'late'))
    await load
    expect(entryOf('s1', 'a.ts')).toBeUndefined()
  })

  it('clears the preview of a closed file tab and keeps the ones still open', async () => {
    const { pending } = deferredReads()
    openFileTab('s1', 'a.ts')
    openFileTab('s1', 'b.ts')
    const a = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    const b = useFileExplorerStore.getState().loadPreview('s1', 'b.ts')
    pending[0]!(textPreview('a.ts', 'A'))
    pending[1]!(textPreview('b.ts', 'B'))
    await Promise.all([a, b])
    useDocumentTabsStore.getState().closeDocumentTab('s1', 'file:a.ts')
    expect(entryOf('s1', 'a.ts')).toBeUndefined()
    expect(entryOf('s1', 'b.ts')?.preview?.content).toBe('B')
  })
})

describe('a file that leaves the tree', () => {
  const patchWithout = (...names: string[]) => ({
    relativePath: '',
    truncated: 0,
    entries: names.map((name) => ({ path: name, name, kind: 'file' as const }))
  })

  it('shows the deleted state in a loaded preview', async () => {
    const { pending } = deferredReads()
    const load = useFileExplorerStore.getState().loadPreview('s1', 'a.ts')
    pending[0]!(textPreview('a.ts', 'A'))
    await load
    useFileExplorerStore.getState().applyPatch('s1', patchWithout('b.ts'))
    expect(entryOf('s1', 'a.ts')).toEqual({ preview: { path: 'a.ts', kind: 'deleted' }, loading: false })
  })

  it('marks every open file tab dead, including one with no preview because it is not the active tab', () => {
    deferredReads()
    openFileTab('s1', 'a.ts')
    openFileTab('s1', 'b.ts')
    useFileExplorerStore.getState().applyPatch('s1', patchWithout('b.ts'))
    expect(useDocumentTabsStore.getState().bySession.s1?.tabs.map((tab) => [tab.id, tab.dead])).toEqual([
      ['file:a.ts', true],
      ['file:b.ts', false]
    ])
  })

  it('does not mark a tab dead from a truncated listing, which cannot prove absence', () => {
    deferredReads()
    openFileTab('s1', 'a.ts')
    useFileExplorerStore.getState().applyPatch('s1', { ...patchWithout('b.ts'), truncated: 3 })
    expect(useDocumentTabsStore.getState().bySession.s1?.tabs[0]?.dead).toBe(false)
  })
})
