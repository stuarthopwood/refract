import { create } from 'zustand'
import { toast } from 'sonner'
import type { FilePreview, FileTreeNode, GitStatusMap } from '../../shared/model'
import type { Result } from '../../shared/ipc'

/** Named per the "no `ReturnType<typeof fn>`" convention: mirrors `window.refract.fileExplorer.
 * getStatus`'s own declared return shape (`src/shared/ipc.ts`'s `RefractApi`), owned there --
 * this file only names it locally since that contract file is Slice 1 main-process/IPC surface,
 * out of this slice's own scope to edit. */
type GetStatusResult = Result<{ status: GitStatusMap | null }>
/** Same convention, mirroring `fileExplorer.listDirectory`'s own declared return shape. */
type ListDirectoryResult = Result<{ entries: FileTreeNode[]; truncated: number }>
/** Same convention, mirroring `fileExplorer.readPreview`'s own declared return shape. */
type ReadPreviewResult = Result<{ preview: FilePreview }>

// Spec 015 data-model.md `FileExplorerSessionState`/`FileExplorerStoreState`: per-Session thread
// state, rebuilt fresh on every launch (no renderer-side persistence) -- `fileExplorer.
// listDirectory`/`getStatus` is the single source of truth for anything older than this app run,
// the same reasoning `side-chat-store.ts` (spec 014) uses for its own non-persisted per-Session
// state. Keyed per Session (mirrors `side-chat-store.ts`'s own per-id keying, research.md
// decision 10), not single-Session-at-a-time, since a split's two panes each show their own
// focused Session's tree (the decision comment on #463).

/** The tree's own per-node view-state shape: `FileTreeNode` plus the renderer-only `children`/
 * `expanded` fields (T007's own in-tree design, data-model.md). Recursive ON PURPOSE -- Slice 1
 * originally repeated `FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean }` (NOT
 * actually recursive: a node two levels deep lost those fields' own typing, only the top level
 * ever had them) about six times across this file and `FileExplorerPanel.tsx`; this is the one,
 * correctly-recursive source of truth both now import instead (PR #671 gate fix, code-reviewer
 * MEDIUM). `truncated` (Slice 2, T012): the count of this folder's own entries main's
 * `listDirectory` dropped past its own cap, read straight from `listDirectory`'s `truncated`
 * response field -- `undefined` means "not known to be truncated" (never fetched, or a live
 * patch replaced this folder's children without a fresh count of its own, see `applyPatch`'s
 * own doc comment below). Drives the tree's own virtualised "N more" row. */
export interface ExpandableNode extends FileTreeNode {
  children?: ExpandableNode[]
  expanded?: boolean
  truncated?: number
}

/** One `FILE_EXPLORER_PATCH` event's payload, sans `sessionId` (contracts/ipc.md "File
 * explorer"): the affected directory's own fresh listing, already re-listed/capped/classified/
 * sorted server-side -- `applyPatch` below merges `entries` into that directory's `children` as
 * a full replacement, never diffed, and carries no `truncated` count of its own (the watcher's
 * event payload is intentionally smaller than `listDirectory`'s own response shape). */
export interface FileExplorerPatch {
  relativePath: string
  entries: FileTreeNode[]
}

interface FileExplorerSessionState {
  /** `null` until the root listing's first response arrives (FR-005, FR-004). A synthetic node:
   * `path: ''`, `kind: 'folder'` -- never rendered as a row itself, only its own `children` are
   * (the worktree root has no meaningful "name" of its own to show as a tree row). */
  root: ExpandableNode | null
  /** PR #671 gate fix (code-reviewer HIGH; accessibility-auditor/test-reviewer MEDIUM): replaces
   * the old boolean-only `loaded` flag, which had no way to represent "the root listing failed"
   * -- the panel showed "Loading…" forever, since nothing ever flipped it to anything else.
   * `'loading'` until the FIRST root-listing response for this Session this app run settles;
   * `'error'` once that response fails (stays `'error'`, with the SAME `root` it had before --
   * `null` the first time -- until the user's own Retry succeeds); `'ready'` once it succeeds. */
  status: 'loading' | 'error' | 'ready'
  /** Set alongside `status: 'error'`; the already-plain-English IPC error message, rendered
   * directly in the panel's error state (never a toast -- a toast closes itself, which would
   * leave the panel's own persistent state claiming nothing is wrong). `null` otherwise. */
  error: string | null
  /** FR-009: off by default. Purely a renderer-side row filter -- `listDirectory` itself takes no
   * such flag (`.git` is already never returned by main regardless of this toggle, FR-007); rows
   * whose `gitStatus` mark is `'ignored'` are simply hidden from the rendered tree unless this is
   * `true`. Slice 2. */
  showIgnored: boolean
  /** The row currently selected/focused, for roving-tabindex (FR-022) and resize/panel-switch
   * focus retention (FR-025). `null` when nothing is selected yet. Slice 2. */
  selectedPath: string | null
  /** `GitStatusMap`, refreshed alongside the tree's own live-refresh cycle (FR-010/FR-020) --
   * also merged onto every currently-loaded node's own `gitStatus` field (contracts/ipc.md
   * `fileExplorer.getStatus`'s own doc comment), so a row can read either this map or its own
   * node's `gitStatus`; both always agree. Slice 2. */
  gitStatus: GitStatusMap
  /** The currently-selected file's preview data (FR-012 to FR-015, FR-021). `null` when nothing
   * is selected or previewed. Slice 2. */
  preview: FilePreview | null
  /** True while `fileExplorer.readPreview` is in flight for `preview`'s path, so the preview
   * region can show a loading state rather than stale or empty content. Slice 2. */
  previewLoading: boolean
}

interface FileExplorerStoreState {
  bySession: Record<string, FileExplorerSessionState>
  /** Fetches one directory's immediate children (FR-005). `relativePath` `''` is the worktree
   * root (sets `root` itself, and is the only call that touches `status`/`error` -- see their own
   * doc comments); any other value must already be a node somewhere in the current `root` tree
   * (fetched by an earlier call or present in `root`'s own listing) -- if the tree does not yet
   * contain it, the fetch still runs but the result has nowhere to attach and is silently dropped
   * (this can only happen from a stale call racing a Session switch, the same class of race
   * `side-chat-store.ts`'s own epoch guard exists for; Slice 1 has no epoch guard yet since
   * nothing here is async-racy enough to need one -- a single in-flight `loadDirectory` per
   * directory, never overlapping itself). Slice 2 (T017): a root-load success also kicks off a
   * `fileExplorer.getStatus` fetch, merged into `gitStatus`/every loaded node once it resolves --
   * not awaited, so the tree itself never waits on git status to show as `'ready'`. */
  loadDirectory(sessionId: string, relativePath: string): Promise<void>
  /** Flips an ALREADY-fetched folder's own `expanded` flag with no fetch (collapsing a folder
   * must never re-read it -- only expanding one for the first time does, via `loadDirectory`
   * above). A no-op if the node is not found or has no `children` yet (nothing to collapse). */
  toggleExpanded(sessionId: string, relativePath: string): void
  /** Fired by `FILE_EXPLORER_PATCH` (T013/T014): merges the affected directory's fresh `entries`
   * into `root` as a full replacement of that one directory's own `children`, NEVER touching
   * `expanded` on the patched node or any other node (FR-020, SC-003) -- a plain `withChildrenAt`
   * call would force `expanded: true` on every patch, silently re-expanding a folder the user had
   * deliberately collapsed. Also re-fetches `gitStatus` (T017, folded into this same cycle, no
   * separate poll) and, per FR-021, flips `preview` straight to `{ path, kind: 'deleted' }`
   * (no extra IPC round trip) when the currently-previewed file is a direct child of the patched
   * directory and is no longer present in `entries`. */
  applyPatch(sessionId: string, patch: FileExplorerPatch): void
  /** FR-009: toggles the renderer-side "show ignored files" row filter (see
   * `FileExplorerSessionState.showIgnored`'s own doc comment). A no-op for an unknown Session. */
  setShowIgnored(sessionId: string, value: boolean): void
  /** FR-022/FR-025: records the tree's current roving-tabindex/selection target. A no-op for an
   * unknown Session. */
  setSelectedPath(sessionId: string, path: string | null): void
  /** FR-012 to FR-015: fetches one file's preview. Sets `previewLoading: true` immediately, then
   * `preview`/`previewLoading: false` once `readPreview` settles -- including on an IPC error or
   * a thrown rejection, which clear `preview` to `null` (with a toast) rather than ever leaving
   * `previewLoading` stuck `true`. A no-op for an unknown Session. */
  loadPreview(sessionId: string, relativePath: string): Promise<void>
}

/** Walks `node`'s own subtree, replacing the node whose `path` matches `targetPath` with a copy
 * carrying `children`/`truncated` set and `expanded: true`. Returns `node` unchanged (same
 * reference) when no match exists anywhere under it, so an unrelated branch's object identity is
 * preserved across an unrelated directory's own fetch (cheap to extend with memoised rendering
 * later, Slice 2). Used only by a user-driven expand (`loadDirectory`'s own non-root branch) --
 * the one case where forcing `expanded: true` is correct, since the user just asked to expand
 * this exact folder. */
function withChildrenAt(node: ExpandableNode, targetPath: string, children: FileTreeNode[], truncated: number): ExpandableNode {
  if (node.path === targetPath) return { ...node, children, expanded: true, truncated }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withChildrenAt(child, targetPath, children, truncated))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

/** Companion to `withChildrenAt`: flips `expanded` on the node at `targetPath` in place, without
 * touching `children`. Same "unchanged reference when nothing matched" contract. */
function withExpandedToggled(node: ExpandableNode, targetPath: string): ExpandableNode {
  if (node.path === targetPath) return node.children ? { ...node, expanded: !node.expanded } : node
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withExpandedToggled(child, targetPath))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

/** `applyPatch`'s own merge (FR-020, SC-003): replaces the patched node's `children` wholesale,
 * WITHOUT touching `expanded` on the patched node (a watcher event must never silently re-expand
 * a folder the user collapsed) or on any other node -- the one difference from `withChildrenAt`
 * above. `truncated` is reset to `undefined` rather than carried forward: the patch payload (see
 * `FileExplorerPatch`'s own doc comment) carries no fresh count of its own, and showing a stale
 * "N more" figure that may no longer match `entries.length` would be worse than showing none
 * until the next real `listDirectory` call refreshes it (judgment call -- flagged in the PR). */
function withPatchedChildren(node: ExpandableNode, targetPath: string, entries: FileTreeNode[]): ExpandableNode {
  if (node.path === targetPath) return { ...node, children: entries, truncated: undefined }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withPatchedChildren(child, targetPath, entries))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

/** `fileExplorer.getStatus`'s own doc comment (contracts/ipc.md): "the renderer merges this into
 * every currently-loaded node's `gitStatus`". Walks the whole tree, setting (or clearing) each
 * node's own `gitStatus` mark from `statusMap`; same "unchanged reference when nothing changed"
 * contract as the helpers above, so an unrelated render never re-runs off this alone. */
function withGitStatusMerged(node: ExpandableNode, statusMap: GitStatusMap): ExpandableNode {
  const mark = statusMap[node.path]
  const selfChanged = mark !== node.gitStatus
  if (!node.children) return selfChanged ? { ...node, gitStatus: mark } : node
  const nextChildren = node.children.map((child) => withGitStatusMerged(child, statusMap))
  const childrenChanged = nextChildren.some((child, i) => child !== node.children![i])
  if (!selfChanged && !childrenChanged) return node
  return { ...node, gitStatus: mark, children: nextChildren }
}

/** Relative-path parent (POSIX `/` separators, `FileTreeNode.path`'s own convention): `''` for a
 * top-level entry (its parent is the worktree root itself). Used only by `applyPatch`'s own
 * FR-021 check below, to tell whether the currently-previewed file is a DIRECT child of the
 * patched directory (the only case a patch's `entries` can tell us anything about its presence). */
function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** T017: best-effort `fileExplorer.getStatus` fetch, merged into `gitStatus` and every loaded
 * node's own `gitStatus` field once it resolves. Never throws into its caller (mirrors
 * `diffStat.ts`'s own never-throw-into-renderer convention this reader already follows
 * main-side) and never shows a toast -- git status is a quiet enhancement layer, not something
 * the user took an action to request, so a failure here degrades to "no marks shown" rather than
 * interrupting anything. A no-op if the Session has no session state (no fetch has reached
 * `loadDirectory` yet for it) or if `root` is `null` (there is no tree to merge marks onto). */
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

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},

  async loadDirectory(sessionId, relativePath) {
    if (relativePath === '') {
      // PR #671 gate fix: marks the Session `'loading'` up front (covers both the very first
      // open AND an explicit Retry after a previous `'error'`) -- the previous version had
      // nothing to flip away from an implicit, permanent "not loaded yet". Slice 2: carries
      // forward whatever `showIgnored`/`selectedPath`/`gitStatus`/`preview` this Session already
      // had (a Retry is a root reload, not a reset of the user's own row filter/selection).
      set((state) => {
        const existing = state.bySession[sessionId]
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              root: existing?.root ?? null,
              status: 'loading',
              error: null,
              showIgnored: existing?.showIgnored ?? false,
              selectedPath: existing?.selectedPath ?? null,
              gitStatus: existing?.gitStatus ?? {},
              preview: existing?.preview ?? null,
              previewLoading: existing?.previewLoading ?? false
            }
          }
        }
      })
    }
    let result: ListDirectoryResult
    try {
      result = await window.refract.fileExplorer.listDirectory(sessionId, relativePath)
    } catch {
      // PR #671 gate fix (code-reviewer LOW, round 2): an IPC invoke that REJECTS outright
      // (rather than resolving to `{ ok: false }`, e.g. a thrown exception inside the main
      // handler's own `Promise.all`) used to leave `status: 'loading'` forever with an
      // unhandled rejection -- no error state, no Retry, nothing for the user to do.
      if (relativePath === '') {
        set((state) => {
          const existing = state.bySession[sessionId]
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                root: existing?.root ?? null,
                status: 'error',
                error: `Couldn't load this Session's files`,
                showIgnored: existing?.showIgnored ?? false,
                selectedPath: existing?.selectedPath ?? null,
                gitStatus: existing?.gitStatus ?? {},
                preview: existing?.preview ?? null,
                previewLoading: existing?.previewLoading ?? false
              }
            }
          }
        })
        return
      }
      toast.error(`Couldn't load that folder`)
      return
    }
    if (!result.ok) {
      if (relativePath === '') {
        // PR #671 gate fix: a persistent, retryable error state instead of a one-shot toast that
        // left `loaded`/`status` claiming "still loading" forever (`contracts/ipc.md`'s
        // `worktree-missing`/`outside-worktree`/`file-missing` codes already carry a plain-
        // English message, reused verbatim here).
        set((state) => {
          const existing = state.bySession[sessionId]
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                root: existing?.root ?? null,
                status: 'error',
                error: result.error.message,
                showIgnored: existing?.showIgnored ?? false,
                selectedPath: existing?.selectedPath ?? null,
                gitStatus: existing?.gitStatus ?? {},
                preview: existing?.preview ?? null,
                previewLoading: existing?.previewLoading ?? false
              }
            }
          }
        })
        return
      }
      // A non-root (folder-expand) failure has no dedicated per-row error state yet in Slice 1 --
      // Slice 2's tree pattern (T012) is where that lands. A toast remains better than silence
      // for that one case (gate-fix precedent, side-chat round 2).
      toast.error(result.error.message)
      return
    }
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
            [sessionId]: {
              root,
              status: 'ready',
              error: null,
              showIgnored: existing?.showIgnored ?? false,
              selectedPath: existing?.selectedPath ?? null,
              gitStatus: existing?.gitStatus ?? {},
              preview: existing?.preview ?? null,
              previewLoading: existing?.previewLoading ?? false
            }
          }
        }
      }
      if (!existing?.root) return state // stale call, nothing to attach to (see loadDirectory's own doc comment)
      // Live-verification fix: `withChildrenAt` attaches `result.value.entries` RAW -- these
      // newly-fetched children have never been through `withGitStatusMerged`, so a folder
      // expanded AFTER the root's own `fetchAndMergeStatus` already resolved would otherwise
      // show every new child with no status mark at all, even though `existing.gitStatus`
      // already has the right answer for them (caught live: expanding `src` after the root load
      // rendered `index.ts`/`staged.ts` with no mark, while root-level files already fetched at
      // the same time correctly showed theirs). Applying the already-known map here needs no
      // extra IPC round trip -- `fetchAndMergeStatus`'s own job is fetching a FRESH map, not
      // applying an existing one.
      const attached = withChildrenAt(existing.root, relativePath, result.value.entries, result.value.truncated)
      const root = withGitStatusMerged(attached, existing.gitStatus)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
    // T017: not awaited -- the tree itself just flipped to `'ready'` above and must never wait on
    // git status to show it.
    if (relativePath === '') void fetchAndMergeStatus(sessionId, set)
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
      const root = withPatchedChildren(existing.root, patch.relativePath, patch.entries)
      // FR-021: the previewed file is a DIRECT child of the patched directory and is no longer
      // among its fresh entries -- flip straight to the "no longer exists" state, no extra round
      // trip to `readPreview` (contracts/ipc.md's own `FILE_EXPLORER_PATCH` doc comment).
      const selectedPath = existing.selectedPath
      const stillPresent = selectedPath === null || patch.entries.some((entry) => entry.path === selectedPath)
      const previewDeleted = selectedPath !== null && parentPath(selectedPath) === patch.relativePath && !stillPresent
      if (root === existing.root && !previewDeleted) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...existing,
            root,
            preview: previewDeleted ? { path: selectedPath!, kind: 'deleted' } : existing.preview,
            previewLoading: previewDeleted ? false : existing.previewLoading
          }
        }
      }
    })
    void fetchAndMergeStatus(sessionId, set)
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
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, previewLoading: true } } }
    })
    let result: ReadPreviewResult
    try {
      result = await window.refract.fileExplorer.readPreview(sessionId, relativePath)
    } catch {
      toast.error(`Couldn't preview that file`)
      set((state) => {
        const existing = state.bySession[sessionId]
        if (!existing) return state
        return { bySession: { ...state.bySession, [sessionId]: { ...existing, preview: null, previewLoading: false } } }
      })
      return
    }
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
