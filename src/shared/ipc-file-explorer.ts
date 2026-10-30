// `fileExplorer.*` IPC contract, split out of ipc.ts to stay under its file-size baseline (#806).

import type { Result } from './ipc';
import type { FileTreeNode, FilePreview, GitStatusMap } from './model';

export interface FileExplorerApi {
  /** Lists one directory's immediate children (folders first, then alphabetical); `''` is the worktree root.
   * Paths resolve through `resolveInWorktree` and must stay inside the worktree after symlink resolution, else `outside-worktree`.
   * `.git` is never returned. `truncated` counts entries past a main-side cap enforced before per-entry
   * symlink work, so a huge directory can't force unbounded `readlink`/`stat` calls. */
  listDirectory(sessionId: string, relativePath: string): Promise<Result<{ entries: FileTreeNode[]; truncated: number }>>;
  /** Reads one file's preview with the same containment check as `listDirectory`. Binary (NUL byte in the header) and
   * image (magic bytes) are detected by content, never extension; over-cap files return `kind: 'too-large'`, never a partial read. */
  readPreview(sessionId: string, relativePath: string): Promise<Result<{ preview: FilePreview }>>;
  /** One shared git-status/ignore read for the whole worktree, merged into loaded nodes by the renderer.
   * `null` on any failure (never thrown), in which case the tree renders without marks. */
  getStatus(sessionId: string): Promise<Result<{ status: GitStatusMap | null }>>;
  /** Resolves `Code.exe` via the fixed-install-root resolver (never `resolveExecutable`, never `shell: true`)
   * and spawns it with absolute-path args. `{ opened: false }` when none resolves, a normal result with no silent fallback. */
  openInVSCode(sessionId: string, relativePath: string): Promise<Result<{ opened: boolean }>>;
  /** Reveals a file via `shell.showItemInFolder`, never `shell.openPath`, which would run a `.cmd`/`.ps1`/`.lnk` an agent wrote. */
  reveal(sessionId: string, relativePath: string): Promise<Result<void>>;
  /** Writes the file's absolute path to the clipboard; the renderer tries `navigator.clipboard` first. Error `clipboard-failed`. */
  copyPath(sessionId: string, relativePath: string): Promise<Result<void>>;
  /** Stops the recursive watcher, whose OS directory handle blocks renaming any ancestor of the worktree root.
   * Called when the last `FileExplorerPanel` for a Session unmounts (ref-counted for StrictMode double-mounts). No-op if not watching. */
  stopWatching(sessionId: string): Promise<Result<void>>;
  /** Resumes watching; on a real (re)start every loaded directory is re-flushed through the patch queue to catch changes made
   * while unwatched. No-op if archived or already watching; if the worktree no longer resolves, a one-shot reset is sent. */
  ensureWatching(sessionId: string): Promise<Result<void>>;
}
