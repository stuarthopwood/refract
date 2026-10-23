// The `fileExplorer.*` IPC contract (spec 015, the File explorer panel), split into its own file
// to keep `ipc.ts` at its existing file-size baseline (issue #806, `scripts/check-file-size.mjs`)
// -- pure extraction, no existing export moves beyond this one sub-interface, same precedent
// `ipc-attachments.ts`/`ipc-model.ts`/`ipc-git-changes.ts` already set. Split out specifically to
// make room for the Git changes panel's own new `gitChanges.*` channels (spec 018, issue #464),
// which pushed `ipc.ts` back over its baseline even after that extraction alone.

import type { Result } from './ipc';
import type { FileTreeNode, FilePreview, GitStatusMap } from './model';

export interface FileExplorerApi {
  /** Spec 015 contracts/ipc.md "File explorer" (FR-001, FR-004 to FR-007, T004/T005): lists
   * one directory's immediate children only (lazy-load, FR-005 -- never recurses), folders
   * before files then alphabetical within each group (FR-006). `relativePath` `''` lists the
   * worktree root itself (FR-004); any other value is resolved against that Session's
   * worktree root through `resolveInWorktree` (`src/main/ipc/files.ts`, issue #610's own
   * already-hardened containment check, reused unchanged here rather than a second
   * implementation) and MUST stay inside it after resolving symlinks/junctions, or the call
   * fails `outside-worktree` rather than reading outside it. `.git` itself is never returned
   * as an entry (FR-007). `truncated` (Slice 2, PR #671 gate round 2 fix, security-auditor/
   * code-reviewer LOW) is the count of entries past a main-side cap on how many this one
   * directory ever returns -- enforced in main BEFORE any per-entry symlink classification
   * work runs, not only by the renderer's own virtualisation, so a pathologically huge
   * directory can never force unbounded `readlink`/`stat` work; `0` means nothing was cut.
   * No git-status/ignore filtering here (Slice 2, FR-009 to FR-011) -- that is `getStatus`
   * below, merged in by the renderer, never part of this response. */
  listDirectory(sessionId: string, relativePath: string): Promise<Result<{ entries: FileTreeNode[]; truncated: number }>>;
  /** Spec 015 Slice 2 (FR-012 to FR-015, FR-002/FR-003, data-model.md `FilePreview`): reads one
   * file's preview data. Same path-containment check and error codes as `listDirectory`
   * (`resolveInWorktree`, reused unchanged). Binary detection is by content (a NUL byte in a
   * capped header slice, reusing `diffStat.ts`'s own `isBinary` heuristic), never by
   * extension; an image is detected by magic bytes, also never by extension (FR-014). A file
   * over the preview size cap returns `kind: 'too-large'` with `size` set, never a partial
   * read (FR-002, SC-001). */
  readPreview(sessionId: string, relativePath: string): Promise<Result<{ preview: FilePreview }>>;
  /** Spec 015 Slice 2 (FR-010, FR-011, data-model.md `GitStatusMap`): issues the single shared
   * git-status/ignore reader (research.md decisions 2 and 6) once for the whole worktree; the
   * renderer merges this into every currently-loaded node's `gitStatus` rather than calling
   * per-path. `null` on any failure (no git repo, git unavailable, timeout) -- never thrown,
   * mirrors `diffStat.ts`'s own never-throw-into-renderer convention; the tree still renders
   * with no status marks in that case. Built for reuse by #464 (FR-011) -- this method's shape
   * is intentionally generic (a full map, not scoped to the explorer's own currently-expanded
   * paths). */
  getStatus(sessionId: string): Promise<Result<{ status: GitStatusMap | null }>>;
  /** Spec 015 Slice 3 (FR-016, FR-017, research.md decision 1): resolves `Code.exe` via the
   * dedicated fixed-install-root resolver (never `resolveExecutable('code')`/`code.cmd`, never
   * `shell: true`) and spawns it with an absolute-path args array. `{ opened: false }` when no
   * known install root resolves -- a normal result, not an IPC error, so the renderer shows the
   * "VS Code not found" state inline rather than a toast. No silent fallback to any other
   * launcher. */
  openInVSCode(sessionId: string, relativePath: string): Promise<Result<{ opened: boolean }>>;
  /** Spec 015 Slice 3 (FR-018): reveals one file in the OS file explorer via
   * `shell.showItemInFolder`, the exact same hardened pattern `sessions.revealFile` (issue
   * #610) already established -- deliberately NEVER `shell.openPath`, which runs a file's own
   * default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` an agent or tool wrote would execute). */
  reveal(sessionId: string, relativePath: string): Promise<Result<void>>;
  /** Spec 015 Slice 3 (FR-018): writes the file's absolute path to the clipboard. The renderer
   * tries `navigator.clipboard.writeText` itself first (`useWorktreeActions.ts`'s own
   * fallback pattern) and only calls this when the sandboxed renderer refuses it. Error
   * `clipboard-failed` on a main-process clipboard write failure. */
  copyPath(sessionId: string, relativePath: string): Promise<Result<void>>;
  /** PR #671 gate round 7 fix (Sec7/Code7/A11y7/Verif7): the recursive watcher `ensureWatcher`
   * (`src/main/ipc/fileExplorer.ts`) opens an OS directory handle that blocks
   * rename/move of every ancestor of the worktree root for as long as it runs. Stops the
   * watcher for this Session outright -- call `ensureWatching` to resume it. The renderer
   * calls this when the LAST open `FileExplorerPanel` for a Session unmounts (ref-counted per
   * `sessionId` -- round 9 correction: today this is exactly one mounted instance per
   * Session, `App.tsx` renders only one `RightPaneShell`; the ref-count exists for React
   * StrictMode's own dev-time double mount/unmount/remount, not a real multi-instance case).
   * A no-op (never errors) if nothing is currently watching this Session. */
  stopWatching(sessionId: string): Promise<Result<void>>;
  /** Counterpart to `stopWatching`. Round 9 correction (Sec9/Code9/Verif9 Medium): this used
   * to say "restarts the watch handle WITHOUT re-listing any directory" -- round 8 changed
   * that: when a watch handle actually (re)starts, every directory the renderer still has
   * loaded is re-flushed through the existing bounded/deduped patch queue, so changes made
   * while unwatched (including a previewed file's own deletion, FR-021) are caught up via an
   * ordinary patch, not a reset. The renderer's own cached expansion/scroll state (FR-025)
   * survives untouched either way. A no-op if the Session is archived or already being
   * watched; if the worktree folder does not currently resolve AND this Session had cached
   * state from before, a one-shot reset is sent instead of leaving a stale tree marked ready
   * with nothing watching under it. */
  ensureWatching(sessionId: string): Promise<Result<void>>;
}
