// Shared, dependency-free path predicates for the File explorer's worktree-containment logic
// (spec 015). Lives here, not in `src/main/ipc/files.ts` or `src/main/ipc/fileExplorer.ts`,
// specifically so `src/main/git/status.ts` (and any other non-IPC module) can import it without
// pulling in `electron` (`ipcMain`/`shell`) or inverting the git layer's own dependency direction
// (PR #671 gate round 4 fix, Medium, code-reviewer: `status.ts` importing from `ipc/files.ts` had
// no cycle, but the layering was backwards -- a git-status reader has no business depending on an
// IPC-handler module, and a unit test for `status.ts` would need to mock `electron` to satisfy an
// import it never actually uses). This module has zero dependencies of its own.

/** Any path segment equal to `.git`, ASCII case-insensitively -- shared by every caller that needs
 * to reject `.git` itself as a path, a listing entry, or a status-map key (FR-007): `files.ts`'s
 * `resolveListTarget`/`classifySymlinkEntry` (via `fileExplorer.ts`), and `git/status.ts`'s own
 * `.git`-as-a-status-key filter. */
export function containsGitSegment(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')
}
