import { create } from 'zustand'
import { toast } from 'sonner'
import type { FileTreeNode } from '../../shared/model'

// Spec 015 data-model.md `FileExplorerSessionState`/`FileExplorerStoreState`: per-Session thread
// state, rebuilt fresh on every launch (no renderer-side persistence) -- `fileExplorer.
// listDirectory` is the single source of truth for anything older than this app run, the same
// reasoning `side-chat-store.ts` (spec 014) uses for its own non-persisted per-Session state.
// Keyed per Session (mirrors `side-chat-store.ts`'s own per-id keying, research.md decision 10),
// not single-Session-at-a-time, since a split's two panes each show their own focused Session's
// tree (the decision comment on #463).

/** The tree's own per-node view-state shape: `FileTreeNode` plus the renderer-only `children`/
 * `expanded` fields (T007's own in-tree design, data-model.md). Recursive ON PURPOSE -- Slice 1
 * originally repeated `FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean }` (NOT
 * actually recursive: a node two levels deep lost those fields' own typing, only the top level
 * ever had them) about six times across this file and `FileExplorerPanel.tsx`; this is the one,
 * correctly-recursive source of truth both now import instead (PR #671 gate fix, code-reviewer
 * MEDIUM). */
export interface ExpandableNode extends FileTreeNode {
  children?: ExpandableNode[]
  expanded?: boolean
}

/** Slice 1 only: the tree's own shape (`root`), loading/error state. Expansion/selection state,
 * the git-status map, and the preview selection all arrive in Slice 2 -- this interface grows
 * then, not before, so an unused field never sits here half-wired. */
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
   * directory, never overlapping itself). */
  loadDirectory(sessionId: string, relativePath: string): Promise<void>
  /** Flips an ALREADY-fetched folder's own `expanded` flag with no fetch (collapsing a folder
   * must never re-read it -- only expanding one for the first time does, via `loadDirectory`
   * above). A no-op if the node is not found or has no `children` yet (nothing to collapse). */
  toggleExpanded(sessionId: string, relativePath: string): void
}

/** Walks `node`'s own subtree, replacing the node whose `path` matches `targetPath` with a copy
 * carrying `children` set and `expanded: true`. Returns `node` unchanged (same reference) when no
 * match exists anywhere under it, so an unrelated branch's object identity is preserved across an
 * unrelated directory's own fetch (cheap to extend with memoised rendering later, Slice 2). */
function withChildrenAt(node: ExpandableNode, targetPath: string, children: FileTreeNode[]): ExpandableNode {
  if (node.path === targetPath) return { ...node, children, expanded: true }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withChildrenAt(child, targetPath, children))
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

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},

  async loadDirectory(sessionId, relativePath) {
    if (relativePath === '') {
      // PR #671 gate fix: marks the Session `'loading'` up front (covers both the very first
      // open AND an explicit Retry after a previous `'error'`) -- the previous version had
      // nothing to flip away from an implicit, permanent "not loaded yet".
      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: { root: state.bySession[sessionId]?.root ?? null, status: 'loading', error: null }
        }
      }))
    }
    const result = await window.refract.fileExplorer.listDirectory(sessionId, relativePath)
    if (!result.ok) {
      if (relativePath === '') {
        // PR #671 gate fix: a persistent, retryable error state instead of a one-shot toast that
        // left `loaded`/`status` claiming "still loading" forever (`contracts/ipc.md`'s
        // `worktree-missing`/`outside-worktree`/`file-missing` codes already carry a plain-
        // English message, reused verbatim here).
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: { root: state.bySession[sessionId]?.root ?? null, status: 'error', error: result.error.message }
          }
        }))
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
          expanded: true
        }
        return { bySession: { ...state.bySession, [sessionId]: { root, status: 'ready', error: null } } }
      }
      if (!existing?.root) return state // stale call, nothing to attach to (see loadDirectory's own doc comment)
      const root = withChildrenAt(existing.root, relativePath, result.value.entries)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
  },

  toggleExpanded(sessionId, relativePath) {
    set((state) => {
      const existing = state.bySession[sessionId]
      if (!existing?.root) return state
      const root = withExpandedToggled(existing.root, relativePath)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
  }
}))
