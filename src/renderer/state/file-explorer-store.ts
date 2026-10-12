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

/** Slice 1 only: the tree's own shape (`root`), loading/error flags. Expansion/selection state,
 * the git-status map, and the preview selection all arrive in Slice 2 -- this interface grows
 * then, not before, so an unused field never sits here half-wired. */
interface FileExplorerSessionState {
  /** `null` until the root listing's first response arrives (FR-005, FR-004). A synthetic node:
   * `path: ''`, `kind: 'folder'` -- never rendered as a row itself, only its own `children` are
   * (the worktree root has no meaningful "name" of its own to show as a tree row). */
  root: (FileTreeNode & { children?: FileTreeNode[] }) | null
  /** True once the root listing has succeeded at least once for this Session this app run
   * (mirrors `side-chat-store.ts`'s own `loaded` field and its own reasoning: a failed load must
   * retry once the Session starts, never be cached as "there is nothing here"). */
  loaded: boolean
}

const EMPTY_SESSION_STATE: FileExplorerSessionState = { root: null, loaded: false }

interface FileExplorerStoreState {
  bySession: Record<string, FileExplorerSessionState>
  /** Fetches one directory's immediate children (FR-005). `relativePath` `''` is the worktree
   * root (sets `root` itself); any other value must already be a node somewhere in the current
   * `root` tree (fetched by an earlier call or present in `root`'s own listing) -- if the tree
   * does not yet contain it, the fetch still runs but the result has nowhere to attach and is
   * silently dropped (this can only happen from a stale call racing a Session switch, the same
   * class of race `side-chat-store.ts`'s own epoch guard exists for; Slice 1 has no epoch guard
   * yet since nothing here is async-racy enough to need one -- a single in-flight `loadDirectory`
   * per directory, never overlapping itself). */
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
function withChildrenAt(
  node: FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean },
  targetPath: string,
  children: FileTreeNode[]
): FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean } {
  if (node.path === targetPath) return { ...node, children, expanded: true }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withChildrenAt(child, targetPath, children))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

/** Companion to `withChildrenAt`: flips `expanded` on the node at `targetPath` in place, without
 * touching `children`. Same "unchanged reference when nothing matched" contract. */
function withExpandedToggled(
  node: FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean },
  targetPath: string
): FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean } {
  if (node.path === targetPath) return node.children ? { ...node, expanded: !node.expanded } : node
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withExpandedToggled(child, targetPath))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},

  async loadDirectory(sessionId, relativePath) {
    const result = await window.refract.fileExplorer.listDirectory(sessionId, relativePath)
    if (!result.ok) {
      // Gate-fix precedent (side-chat, round 2): `agent-not-running`-shaped failures are not
      // this spec's own error vocabulary (file reads do not require a live agent at all -- the
      // worktree exists whether or not OMP is running), so every failure here is a genuine one,
      // always worth a toast. `worktree-missing`/`outside-worktree`/`file-missing` are this
      // spec's own typed codes (contracts/ipc.md); their message is already plain English.
      toast.error(result.error.message)
      return
    }
    set((state) => {
      const existing = state.bySession[sessionId] ?? EMPTY_SESSION_STATE
      if (relativePath === '') {
        const root: FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean } = {
          path: '',
          name: '',
          kind: 'folder',
          children: result.value.entries,
          expanded: true
        }
        return { bySession: { ...state.bySession, [sessionId]: { root, loaded: true } } }
      }
      if (!existing.root) return state // stale call, nothing to attach to (see loadDirectory's own doc comment)
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
