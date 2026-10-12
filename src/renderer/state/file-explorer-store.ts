import { create } from 'zustand'
import { toast } from 'sonner'
import type { FilePreview, FileTreeNode, GitStatusMap, GitStatusMark } from '../../shared/model'
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
 * a full replacement, never diffed. `truncated` (gate-fix round 5, Code5 Medium) is that fresh
 * listing's own truncation count, carried into the merged node -- previously discarded on every
 * patch, so a >1000-entry folder's "N more" row vanished after its first live edit. */
export interface FileExplorerPatch {
  relativePath: string
  entries: FileTreeNode[]
  truncated: number
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
   * into `root` by PATH, preserving any surviving same-kind child's own `children`/`expanded`/
   * `truncated`/`gitStatus` (FR-020, SC-003) -- PR #671 gate round 4 fix (Critical/High): a
   * plain wholesale-replace (the original design) collapsed EVERY expanded descendant anywhere
   * under the patched directory on every single patch. Also coalesces a fresh `gitStatus` fetch
   * (T017, debounced, at most one in-flight plus one trailing per Session -- never one per
   * patch) and, per FR-021, flips `preview` straight to `{ path, kind: 'deleted' }` (no extra IPC
   * round trip) when the actually-PREVIEWED file (never merely the selected/focused row, which
   * arrow-key navigation can change without ever calling `loadPreview`) is no longer reachable
   * under the patched directory, whether as a direct child or because the patched directory is
   * one of its own ancestor folders. */
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
  /** Gate-fix (round 5, Code5 HIGH1): fired on `FILE_EXPLORER_RESET` (the watcher-fatal/
   * recreate-worktree/restore/archive lifecycle signal, contracts/ipc.md) -- drops the
   * Session's entire `bySession[sessionId]` entry so the panel's own "load root once per
   * Session, gated on `bySession` absence" effect naturally re-fires `loadDirectory(sessionId,
   * '')`, re-establishing a fresh watcher instead of leaving a stale tree showing forever with
   * nothing watching underneath it. A no-op for an unknown Session. */
  resetSession(sessionId: string): void
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

/** `applyPatch`'s own merge (FR-020, SC-003): for each fresh `entries[i]`, if an OLD child at
 * the same `path` existed with the SAME `kind`, carries over that child's own `children`/
 * `expanded`/`truncated`/`gitStatus` -- a NEW entry, or one whose `kind` changed (a file replaced
 * by a folder of the same name or vice versa), comes in bare, since there is nothing of the old
 * shape left to carry over. PR #671 gate round 4 fix (Critical/High, Sec4/Code4/A11y4/Verif4,
 * reproduced live by all four reviewers): the previous version replaced `children` with the raw
 * `entries` WHOLESALE, so a patch for ANY folder collapsed EVERY expanded descendant anywhere
 * under it and dropped focus to `<body>` if the focused row was one of them. On Windows, editing
 * a file inside `src` also changes `src`'s own directory mtime, which the watcher queues as a
 * root-level ('') patch too (`watchDirectory.ts`'s own debounce groups both into one flush, but
 * both still fire) -- a plain-replace design turned "any file edit anywhere" into "the whole
 * tree collapses", exactly what the lane's own `09-preview-deleted-live.png` screenshot showed
 * happening to the un-related `src` folder after a root-level delete. */
function withPatchedChildren(node: ExpandableNode, targetPath: string, entries: FileTreeNode[], truncated: number): ExpandableNode {
  if (node.path === targetPath) {
    const oldByPath = new Map((node.children ?? []).map((child) => [child.path, child] as const))
    const nextChildren: ExpandableNode[] = entries.map((entry) => {
      const old = oldByPath.get(entry.path)
      if (old && old.kind === entry.kind) {
        return { ...entry, children: old.children, expanded: old.expanded, truncated: old.truncated, gitStatus: old.gitStatus }
      }
      return entry
    })
    // Gate round 5 fix (Code5 Medium): carries the patch's own `truncated` count forward
    // instead of always resetting it to `undefined` -- the "N more" row otherwise disappeared
    // from a >1000-entry folder after its first live edit.
    return { ...node, children: nextChildren, truncated }
  }
  if (!node.children) return node
  const nextChildren = node.children.map((child) => withPatchedChildren(child, targetPath, entries, truncated))
  if (nextChildren.every((child, i) => child === node.children![i])) return node
  return { ...node, children: nextChildren }
}

/** `fileExplorer.getStatus`'s own doc comment (contracts/ipc.md): "the renderer merges this into
 * every currently-loaded node's `gitStatus`". Walks the whole tree, setting (or clearing) each
 * node's own `gitStatus` mark from `statusMap`; same "unchanged reference when nothing changed"
 * contract as the helpers above, so an unrelated render never re-runs off this alone.
 *
 * `inheritedMark` (PR #671 gate round 4 fix, High, Sec4/Code4/Verif4, reproduced live): git's own
 * `--ignored=matching` output marks an entirely ignored or untracked FOLDER exactly ONCE (`!!
 * node_modules/`, `?? newdir/`) -- it never recurses into that folder's own contents to mark each
 * file inside it separately, unlike a `modified`/`added`/`deleted` mark, which git ALWAYS reports
 * per individual FILE (a folder is never reported that way in git's own porcelain output). A
 * child with no explicit entry of its own therefore inherits the nearest ignored/untracked
 * ancestor FOLDER's own resolved mark, so `node_modules/some/deep/file.ts` is marked (and hidden
 * by the "show ignored files" toggle, FR-009) the same way `node_modules` itself is, once
 * expanded -- without this, every file inside an ignored or untracked folder showed no mark and
 * no hiding at all. A child's own EXPLICIT entry (e.g. a file force-added inside an otherwise-
 * ignored folder) always wins over an inherited mark. */
function withGitStatusMerged(node: ExpandableNode, statusMap: GitStatusMap, inheritedMark?: GitStatusMark): ExpandableNode {
  const ownMark = statusMap[node.path]
  const mark = ownMark ?? inheritedMark
  const selfChanged = mark !== node.gitStatus
  if (!node.children) return selfChanged ? { ...node, gitStatus: mark } : node
  // Gate round 5 fix (Code5 Low): a folder's own mark inherits to its children ONLY when it is
  // `'ignored'`/`'untracked'` -- those are the two marks git's own porcelain output genuinely
  // reports once per FOLDER rather than per file (this function's own doc comment above). Any
  // other mark (e.g. `modified`, reported for a SUBMODULE as a single ` M sub` row) previously
  // propagated to every descendant too, wrongly marking an entire submodule's contents
  // "modified" from one summary row that says nothing about any individual file inside it.
  const childInherited = node.kind === 'folder' && (mark === 'ignored' || mark === 'untracked') ? mark : undefined
  const nextChildren = node.children.map((child) => withGitStatusMerged(child, statusMap, childInherited))
  const childrenChanged = nextChildren.some((child, i) => child !== node.children![i])
  if (!selfChanged && !childrenChanged) return node
  return { ...node, gitStatus: mark, children: nextChildren }
}

/** Relative-path parent (POSIX `/` separators, `FileTreeNode.path`'s own convention): `''` for a
 * top-level entry (its parent is the worktree root itself). */
function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** FR-021: true when `previewPath` is no longer reachable given a patch for `patchedPath`'s own
 * fresh `entries`. Two cases: `previewPath` is a DIRECT child of `patchedPath` and missing from
 * `entries` outright; or `patchedPath` is a proper ANCESTOR folder of `previewPath` and the next
 * path segment on the way down to it is missing from `entries` -- an ancestor folder disappearing
 * is just as fatal to the previewed file as the file itself disappearing, and a patch for that
 * ancestor (never for the file's own, now-gone, immediate parent directory, which no longer
 * exists to be watched) is the only signal this store ever gets about it. PR #671 gate round 4
 * fix (High, Code4): the previous version checked `existing.selectedPath` -- arrow-key navigation
 * (`moveToRow`/`onRowFocus`) changes `selectedPath` WITHOUT ever calling `loadPreview`, so moving
 * focus to a file that is then deleted wiped a completely different, still-open preview; and
 * deleting the actually-previewed file AFTER focus had moved elsewhere left its stale content
 * showing. Basing this on `preview.path` itself fixes both directions. */
function isPathGoneUnderPatch(previewPath: string, patchedPath: string, entries: FileTreeNode[], truncated: number): boolean {
  // Gate round 5 fix (Code5 Low): when the fresh listing is itself truncated, "missing from
  // `entries`" proves nothing -- an entry can be absent simply because the cap pushed it past
  // `MAX_ENTRIES_PER_DIRECTORY`, not because it was deleted. Never declares the preview gone in
  // that case; a later, untruncated patch (or `loadPreview`'s own re-check on next navigation)
  // still catches a genuine deletion.
  if (truncated > 0) return false
  // Gate round 5 fix (Code5 Low): case-insensitive compare (NTFS/Windows convention, matching
  // `sortEntries`'s own `sensitivity: 'base'` comparison elsewhere in this codebase) -- a
  // case-only rename (`foo.ts` -> `Foo.ts`) previously read as "the old path is gone", wrongly
  // flipping a live preview to the `'deleted'` state for a file that still exists.
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

// PR #671 gate round 4 fix (High, Sec4/Code4, reproduced live: 31/60 concurrent agent `git add`/
// `commit` operations failed with "Unable to create '.git/index.lock': File exists" without this):
// coalesces `fetchAndMergeStatus` to at most ONE in-flight call plus ONE trailing call per
// Session, debounced by `STATUS_FETCH_DEBOUNCE_MS` -- a burst of several watcher patches arriving
// in quick succession (the common case: an agent's own `pnpm install`/checkout touching many
// directories at once) previously started its OWN independent `getStatus`/`git status` call per
// patch, with no limit at all.
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
      // A fetch from an earlier debounce window is still running (a slow/huge repo) -- queue
      // exactly one trailing fetch once it finishes, never a second concurrent one.
      scheduleStatusFetch(sessionId, set)
      return
    }
    current.inFlight = true
    void fetchAndMergeStatus(sessionId, set).finally(() => {
      current.inFlight = false
    })
  }, STATUS_FETCH_DEBOUNCE_MS)
}

/** DRY helper (PR #671 gate round 4 fix, Medium, Code4): the full `FileExplorerSessionState`
 * object was written out four times across `loadDirectory`'s own branches, each repeating the
 * same five carried-forward defaults. `patch` supplies the three fields each call site actually
 * changes; everything else carries forward from `existing` (or its own first-time default). */
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

// PR #671 gate round 4 fix (Medium, Code4): a per-Session monotonic request sequence for
// `loadPreview` -- clicking file A then quickly clicking file B used to let A's slower response
// land AFTER B's and overwrite it, since neither request knew about the other. Only the response
// matching the LATEST request for a Session is ever applied; an older one is silently dropped.
const previewRequestSeq = new Map<string, number>()

export const useFileExplorerStore = create<FileExplorerStoreState>((set) => ({
  bySession: {},

  async loadDirectory(sessionId, relativePath) {
    if (relativePath === '') {
      // PR #671 gate fix: marks the Session `'loading'` up front (covers both the very first
      // open AND an explicit Retry after a previous `'error'`) -- the previous version had
      // nothing to flip away from an implicit, permanent "not loaded yet". Slice 2: carries
      // forward whatever `showIgnored`/`selectedPath`/`gitStatus`/`preview` this Session already
      // had (a Retry is a root reload, not a reset of the user's own row filter/selection).
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
      // PR #671 gate fix (code-reviewer LOW, round 2): an IPC invoke that REJECTS outright
      // (rather than resolving to `{ ok: false }`, e.g. a thrown exception inside the main
      // handler's own `Promise.all`) used to leave `status: 'loading'` forever with an
      // unhandled rejection -- no error state, no Retry, nothing for the user to do.
      if (relativePath === '') {
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
        // PR #671 gate fix: a persistent, retryable error state instead of a one-shot toast that
        // left `loaded`/`status` claiming "still loading" forever (`contracts/ipc.md`'s
        // `worktree-missing`/`outside-worktree`/`file-missing` codes already carry a plain-
        // English message, reused verbatim here).
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
            [sessionId]: withSessionDefaults(existing, { root, status: 'ready', error: null })
          }
        }
      }
      if (!existing?.root) return state // stale call, nothing to attach to (see loadDirectory's own doc comment)
      // Live-verification fix: `withChildrenAt` attaches `result.value.entries` RAW -- these
      // newly-fetched children have never been through `withGitStatusMerged`, so a folder
      // expanded AFTER the root's own `fetchAndMergeStatus` already resolved would otherwise
      // show every new child with no status mark at all, even though `existing.gitStatus`
      // already has the right answer for them. Applying the already-known map here needs no
      // extra IPC round trip -- `fetchAndMergeStatus`'s own job is fetching a FRESH map, not
      // applying an existing one.
      const attached = withChildrenAt(existing.root, relativePath, result.value.entries, result.value.truncated)
      const root = withGitStatusMerged(attached, existing.gitStatus)
      if (root === existing.root) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...existing, root } } }
    })
    // T017: not awaited -- the tree itself just flipped to `'ready'` above and must never wait on
    // git status to show it.
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
      // FR-021: based on the actually-PREVIEWED file's own path, not the row merely selected/
      // focused (see `isPathGoneUnderPatch`'s own doc comment for why those differ) -- flips
      // straight to the "no longer exists" state, no extra round trip to `readPreview`
      // (contracts/ipc.md's own `FILE_EXPLORER_PATCH` doc comment).
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
    // Still superseded-checked below rather than skipped outright: this flips `previewLoading`
    // on immediately so the UI shows a loading state the instant a NEW selection is made, even
    // while an older request is still technically in flight.
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
