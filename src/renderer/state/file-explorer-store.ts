import { create } from 'zustand'
import { toast } from 'sonner'
import type { FilePreview, FileTreeNode, GitStatusMap, GitStatusMark } from '../../shared/model'
import type { Result } from '../../shared/ipc'

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

interface FileExplorerSessionState {
  root: ExpandableNode | null
  status: 'loading' | 'error' | 'ready'
  error: string | null
  showIgnored: boolean
  selectedPath: string | null
  gitStatus: GitStatusMap
  preview: FilePreview | null
  previewLoading: boolean
}

interface FileExplorerStoreState {
  bySession: Record<string, FileExplorerSessionState>
  loadDirectory(sessionId: string, relativePath: string): Promise<void>
  toggleExpanded(sessionId: string, relativePath: string): void
  applyPatch(sessionId: string, patch: FileExplorerPatch): void
  setShowIgnored(sessionId: string, value: boolean): void
  setSelectedPath(sessionId: string, path: string | null): void
  loadPreview(sessionId: string, relativePath: string): Promise<void>
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
    gitStatus: existing?.gitStatus ?? {},
    preview: existing?.preview ?? null,
    previewLoading: existing?.previewLoading ?? false
  }
}

const previewRequestSeq = new Map<string, number>()

const rootLoadSeq = new Map<string, number>()

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},

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
      if (!existing?.root) return state
      const root = withPatchedChildren(existing.root, patch.relativePath, patch.entries, patch.truncated)
      const previewPath = existing.preview?.path ?? null
      const previewGone =
        previewPath !== null && isPathGoneUnderPatch(previewPath, patch.relativePath, patch.entries, patch.truncated)
      if (root === existing.root && !previewGone) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...existing,
            root,
            preview: previewGone ? { path: previewPath!, kind: 'deleted' } : existing.preview,
            previewLoading: previewGone ? false : existing.previewLoading
          }
        }
      }
    })
    scheduleStatusFetch(sessionId, set)
  },

  resetSession(sessionId) {
    rootLoadSeq.set(sessionId, (rootLoadSeq.get(sessionId) ?? 0) + 1)
    set((state) => {
      if (!(sessionId in state.bySession)) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
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
    const seq = (previewRequestSeq.get(sessionId) ?? 0) + 1
    previewRequestSeq.set(sessionId, seq)
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, previewLoading: true } } }
    })
    let result: ReadPreviewResult
    try {
      result = await window.refract.fileExplorer.readPreview(sessionId, relativePath)
    } catch {
      if (previewRequestSeq.get(sessionId) !== seq) return // superseded by a newer selection
      toast.error(`Couldn't preview that file`)
      set((state) => {
        const existing = state.bySession[sessionId]
        if (!existing) return state
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, preview: null, previewLoading: false } } }
      })
      return
    }
    if (previewRequestSeq.get(sessionId) !== seq) return // superseded by a newer selection
    if (!result.ok) {
      toast.error(result.error.message)
      set((state) => {
        const existing = state.bySession[sessionId]
        if (!existing) return state
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, preview: null, previewLoading: false } } }
      })
      return
    }
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, preview: result.value.preview, previewLoading: false } } }
    })
  }
}))
