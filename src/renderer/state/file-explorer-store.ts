import { create } from 'zustand'
import { toast } from 'sonner'
import type { FilePreview, FileTreeNode, GitStatusMap, GitStatusMark } from '../../shared/model'
import type { Result } from '../../shared/ipc'
import { useDocumentTabsStore } from './document-tabs-store'

type GetStatusResult = Result<{ status: GitStatusMap | null }>
type ListDirectoryResult = Result<{ entries: FileTreeNode[]; truncated: number }>
type ReadPreviewResult = Result<{ preview: FilePreview }>

/** The tree's own per-node view-state shape: */
export interface ExpandableNode extends FileTreeNode {
  children?: ExpandableNode[]
  expanded?: boolean
  truncated?: number
}

/** One `FILE_EXPLORER_PATCH` event's payload, sans `sessionId` (contracts/ipc.md "File */
export interface FileExplorerPatch {
  relativePath: string
  entries: FileTreeNode[]
  truncated: number
}

export interface PreviewEntry {
  preview: FilePreview | null
  loading: boolean
}

type PreviewsBySession = Record<string, Record<string, PreviewEntry>>

interface FileExplorerSessionState {
  root: ExpandableNode | null
  status: 'loading' | 'error' | 'ready'
  error: string | null
  showIgnored: boolean
  selectedPath: string | null
  gitStatus: GitStatusMap
}

interface FileExplorerStoreState {
  bySession: Record<string, FileExplorerSessionState>
  /** File tab previews by Session then path, apart from the tree because a restored tab can preview before the tree loads. */
  previews: PreviewsBySession
  loadDirectory(sessionId: string, relativePath: string): Promise<void>
  toggleExpanded(sessionId: string, relativePath: string): void
  applyPatch(sessionId: string, patch: FileExplorerPatch): void
  setShowIgnored(sessionId: string, value: boolean): void
  setSelectedPath(sessionId: string, path: string | null): void
  loadPreview(sessionId: string, relativePath: string): Promise<void>
  /** Forgets one path's preview and cancels its load; a closed file tab triggers it (see the subscription below). */
  clearPreview(sessionId: string, relativePath: string): void
  resetSession(sessionId: string): void
}

function withChildrenAt(node: ExpandableNode, targetPath: string, children: FileTreeNode[], truncated: number): ExpandableNode {
  if (node.path === targetPath) return { ...node, children, expanded: true, truncated }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withChildrenAt(child, targetPath, children, truncated))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

function withExpandedToggled(node: ExpandableNode, targetPath: string): ExpandableNode {
  if (node.path === targetPath) return node.children ? { ...node, expanded: !node.expanded } : node
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withExpandedToggled(child, targetPath))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

function withPatchedChildren(node: ExpandableNode, targetPath: string, entries: FileTreeNode[], truncated: number): ExpandableNode {
  if (node.path === targetPath) {
    const oldByPath = new Map((node.children ?? []).map((child) => [child.path.toLowerCase(), child] as const))
    const nextChildren: ExpandableNode[] = entries.map((entry) => {
      const old = oldByPath.get(entry.path.toLowerCase())
      if (old && old.kind === entry.kind) {
        return { ...entry, children: old.children, expanded: old.expanded, truncated: old.truncated, gitStatus: old.gitStatus }
      }
      return entry
    })
    return { ...node, children: nextChildren, truncated }
  }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withPatchedChildren(child, targetPath, entries, truncated))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

function withGitStatusMerged(node: ExpandableNode, statusMap: GitStatusMap, inheritedMark?: GitStatusMark): ExpandableNode {
  const ownMark = statusMap[node.path]
  const mark = ownMark ?? inheritedMark
  const selfChanged = mark !== node.gitStatus
  if (!node.children) return selfChanged ? { ...node, gitStatus: mark } : node
  const childInherited = node.kind === 'folder' && (mark === 'ignored' || mark === 'untracked') ? mark : undefined
  const nextChildren = node.children.map((child) => withGitStatusMerged(child, statusMap, childInherited))
  const childrenChanged = nextChildren.some((child, i) => child !== node.children![i])
  if (!selfChanged && !childrenChanged) return node
  return { ...node, gitStatus: mark, children: nextChildren }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function isPathGoneUnderPatch(previewPath: string, patchedPath: string, entries: FileTreeNode[], truncated: number): boolean {
  if (truncated > 0) return false
  const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  if (parentPath(previewPath) === patchedPath) {
    return !entries.some((entry) => samePath(entry.path, previewPath))
  }
  const prefix = patchedPath === '' ? '' : `${patchedPath}/`
  if (previewPath === patchedPath || !previewPath.startsWith(prefix)) return false
  const nextSegment = previewPath.slice(prefix.length).split('/')[0]!
  const nextSegmentPath = patchedPath === '' ? nextSegment : `${patchedPath}/${nextSegment}`
  return !entries.some((entry) => samePath(entry.path, nextSegmentPath))
}

async function fetchAndMergeStatus(
  sessionId: string,
  set: (fn: (state: FileExplorerStoreState) => Partial<FileExplorerStoreState>) => void
): Promise<void> {
  let result: GetStatusResult
  try {
    result = await window.refract.fileExplorer.getStatus(sessionId)
  } catch {
    return
  }
  if (!result.ok || !result.value.status) return
  const statusMap = result.value.status
  set((state) => {
    const existing = state.bySession[sessionId]
    if (!existing) return state
    const root = existing.root ? withGitStatusMerged(existing.root, statusMap) : existing.root
    return { bySession: { ...state.bySession, [sessionId]: { ...existing, gitStatus: statusMap, root } } }
  })
}

const STATUS_FETCH_DEBOUNCE_MS = 500
interface StatusFetchEntry {
  inFlight: boolean
  timer?: ReturnType<typeof setTimeout>
}
const statusFetchState = new Map<string, StatusFetchEntry>()

function scheduleStatusFetch(
  sessionId: string,
  set: (fn: (state: FileExplorerStoreState) => Partial<FileExplorerStoreState>) => void
): void {
  let entry = statusFetchState.get(sessionId)
  if (!entry) {
    entry = { inFlight: false }
    statusFetchState.set(sessionId, entry)
  }
  if (entry.timer) return // already debouncing one fetch for this Session; nothing more to queue
  entry.timer = setTimeout(() => {
    const current = statusFetchState.get(sessionId)!
    current.timer = undefined
    if (current.inFlight) {
      scheduleStatusFetch(sessionId, set)
      return
    }
    current.inFlight = true
    void fetchAndMergeStatus(sessionId, set).finally(() => {
      current.inFlight = false
    })
  }, STATUS_FETCH_DEBOUNCE_MS)
}

function withSessionDefaults(
  existing: FileExplorerSessionState | undefined,
  patch: Pick<FileExplorerSessionState, 'root' | 'status' | 'error'>
): FileExplorerSessionState {
  return {
    ...patch,
    showIgnored: existing?.showIgnored ?? false,
    selectedPath: existing?.selectedPath ?? null,
    gitStatus: existing?.gitStatus ?? {}
  }
}

/** Newest request per Session and path; clearing a path drops its entry, which discards any load still in flight. */
const previewRequestSeq = new Map<string, number>()
let nextPreviewSeq = 0 // global, so a path cleared and reloaded never reuses a number an old load still holds
const previewKey = (sessionId: string, path: string): string => `${sessionId}\0${path}`

function withPreview(previews: PreviewsBySession, sessionId: string, path: string, entry: PreviewEntry | null): PreviewsBySession {
  const forSession = { ...previews[sessionId] }
  if (entry) forSession[path] = entry
  else delete forSession[path]
  return { ...previews, [sessionId]: forSession }
}

function withGonePreviewsMarked(previews: PreviewsBySession, sessionId: string, patch: FileExplorerPatch): PreviewsBySession {
  const forSession = previews[sessionId]
  if (!forSession) return previews
  const gone = Object.entries(forSession).filter(
    ([path, entry]) => entry.preview !== null && entry.preview.kind !== 'deleted' && isPathGoneUnderPatch(path, patch.relativePath, patch.entries, patch.truncated)
  )
  if (gone.length === 0) return previews
  const marked = { ...forSession }
  for (const [path] of gone) marked[path] = { preview: { path, kind: 'deleted' }, loading: false }
  return { ...previews, [sessionId]: marked }
}

/** An inactive file tab shows no preview, so the tab itself learns its file left the tree. */
function markGoneFileTabs(sessionId: string, patch: FileExplorerPatch): void {
  const documents = useDocumentTabsStore.getState()
  for (const tab of documents.bySession[sessionId]?.tabs ?? []) {
    if (tab.kind === 'file' && !tab.dead && isPathGoneUnderPatch(tab.path, patch.relativePath, patch.entries, patch.truncated)) {
      documents.markDead(sessionId, tab.id, true)
    }
  }
}

const rootLoadSeq = new Map<string, number>()

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},
  previews: {},

  async loadDirectory(sessionId, relativePath) {
    const rootSeq = relativePath === '' ? (rootLoadSeq.get(sessionId) ?? 0) + 1 : 0
    if (relativePath === '') rootLoadSeq.set(sessionId, rootSeq)
    const staleRootLoad = (): boolean => relativePath === '' && rootLoadSeq.get(sessionId) !== rootSeq
    if (relativePath === '') {
      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: withSessionDefaults(state.bySession[sessionId], {
            root: state.bySession[sessionId]?.root ?? null,
            status: 'loading',
            error: null
          })
        }
      }))
    }
    let result: ListDirectoryResult
    try {
      result = await window.refract.fileExplorer.listDirectory(sessionId, relativePath)
    } catch {
      if (relativePath === '') {
        if (staleRootLoad()) return
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: withSessionDefaults(state.bySession[sessionId], {
              root: state.bySession[sessionId]?.root ?? null,
              status: 'error',
              error: `Couldn't load this Session's files`
            })
          }
        }))
        return
      }
      toast.error(`Couldn't load that folder`)
      return
    }
    if (!result.ok) {
      if (relativePath === '') {
        if (staleRootLoad()) return
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: withSessionDefaults(state.bySession[sessionId], {
              root: state.bySession[sessionId]?.root ?? null,
              status: 'error',
              error: result.error.message
            })
          }
        }))
        return
      }
      toast.error(result.error.message)
      return
    }
    if (staleRootLoad()) return
    set((state) => {
      const existing = state.bySession[sessionId]
      if (relativePath === '') {
        const root: ExpandableNode = {
          path: '',
          name: '',
          kind: 'folder',
          children: result.value.entries,
          expanded: true,
          truncated: result.value.truncated
        }
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: withSessionDefaults(existing, { root, status: 'ready', error: null })
          }
        }
      }
      if (!existing?.root) return state // stale call, nothing to attach to (see loadDirectory's own doc comment)
      const attached = withChildrenAt(existing.root, relativePath, result.value.entries, result.value.truncated)
      const root = withGitStatusMerged(attached, existing.gitStatus)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
    if (relativePath === '') scheduleStatusFetch(sessionId, set)
  },

  toggleExpanded(sessionId, relativePath) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing?.root) return state
      const root = withExpandedToggled(existing.root, relativePath)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
  },

  applyPatch(sessionId, patch) {
    set((state) => {
      const existing = state.bySession[sessionId]
      const previews = withGonePreviewsMarked(state.previews, sessionId, patch)
      const patchedRoot = existing?.root ? withPatchedChildren(existing.root, patch.relativePath, patch.entries, patch.truncated) : null
      const bySession = existing && patchedRoot && patchedRoot !== existing.root ? { ...state.bySession, [sessionId]: { ...existing, root: patchedRoot } } : state.bySession
      if (bySession === state.bySession && previews === state.previews) return state
      return { bySession, previews }
    })
    markGoneFileTabs(sessionId, patch)
    scheduleStatusFetch(sessionId, set)
  },

  resetSession(sessionId) {
    rootLoadSeq.set(sessionId, (rootLoadSeq.get(sessionId) ?? 0) + 1)
    for (const key of previewRequestSeq.keys()) if (key.startsWith(`${sessionId}\0`)) previewRequestSeq.delete(key)
    set((state) => {
      if (!(sessionId in state.bySession) && !(sessionId in state.previews)) return state
      const bySession = { ...state.bySession }
      const previews = { ...state.previews }
      delete bySession[sessionId]
      delete previews[sessionId]
      return { bySession, previews }
    })
  },

  setShowIgnored(sessionId, value) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing || existing.showIgnored === value) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, showIgnored: value } } }
    })
  },

  setSelectedPath(sessionId, path) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing || existing.selectedPath === path) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, selectedPath: path } } }
    })
  },

  async loadPreview(sessionId, relativePath) {
    const key = previewKey(sessionId, relativePath)
    const seq = ++nextPreviewSeq
    previewRequestSeq.set(key, seq)
    // A refresh keeps the last preview on screen; only a first load has nothing to show.
    set((state) => ({ previews: withPreview(state.previews, sessionId, relativePath, { preview: state.previews[sessionId]?.[relativePath]?.preview ?? null, loading: true }) }))
    const settle = (preview: FilePreview | null): void =>
      set((state) => ({ previews: withPreview(state.previews, sessionId, relativePath, { preview, loading: false }) }))
    let result: ReadPreviewResult
    try {
      result = await window.refract.fileExplorer.readPreview(sessionId, relativePath)
    } catch {
      if (previewRequestSeq.get(key) !== seq) return // superseded by a newer load, or the tab left the screen
      toast.error(`Couldn't preview that file`)
      settle(null)
      return
    }
    if (previewRequestSeq.get(key) !== seq) return // superseded by a newer load, or the tab left the screen
    if (!result.ok) {
      toast.error(result.error.message)
      settle(null)
      return
    }
    settle(result.value.preview)
  },

  clearPreview(sessionId, relativePath) {
    previewRequestSeq.delete(previewKey(sessionId, relativePath))
    set((state) => (state.previews[sessionId]?.[relativePath] ? { previews: withPreview(state.previews, sessionId, relativePath, null) } : state))
  }
}))

// A closed or dropped file tab takes its cached preview with it; the tabs left open keep theirs for the next activation.
useDocumentTabsStore.subscribe((state, prev) => {
  for (const [sessionId, before] of Object.entries(prev.bySession)) {
    const after = state.bySession[sessionId]?.tabs
    if (after === before.tabs) continue
    const stillOpen = new Set((after ?? []).filter((tab) => tab.kind === 'file').map((tab) => tab.path))
    for (const tab of before.tabs) {
      if (tab.kind === 'file' && !stillOpen.has(tab.path)) useFileExplorerStore.getState().clearPreview(sessionId, tab.path)
    }
  }
})
