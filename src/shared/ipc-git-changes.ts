// The `gitChanges.*` IPC contract (spec 018 slice 1, issue #464), split into its own file to
// keep `ipc.ts` at its existing file-size baseline (issue #806, `scripts/check-file-size.mjs`) --
// pure extraction, no existing export moves beyond this one sub-interface, same precedent
// `ipc-attachments.ts`/`ipc-model.ts` already set.

import type { Result } from './ipc';
import type { GitChangesSnapshot } from './model';

/** Spec 018 contracts/ipc.md "Git changes" (issue #464, slice 1): the right-pane Git changes
 * panel's own full per-Session surface -- `list` (FR-001, FR-002, FR-014), per-file `stage`/
 * `unstage` (FR-006, FR-007), bulk `stageAll`/`unstageAll` (FR-004, re-reading the CURRENT
 * status server-side rather than trusting a client-supplied path list, and deliberately
 * excluding Conflicts from both), `commit` (FR-009 to FR-011), and the watcher lifecycle pair
 * `ensureWatching`/`stopWatching` (FR-015b, FR-016) mirroring `fileExplorer`'s own pair. */
export interface GitChangesApi {
  /** `{ snapshot: null }` when the worktree is not a git repository, a git call failed, or the
   * status read exceeded the same size cap `fileExplorer.getStatus` already enforces
   * (FR-018) -- never thrown, mirrors `fileExplorer.getStatus`'s own never-throw-into-renderer
   * convention. */
  list(sessionId: string): Promise<Result<{ snapshot: GitChangesSnapshot | null }>>;
  /** FR-007: `git add --`, every path a literal post-`--` argv entry sourced only from the
   * current status map's own keys. */
  stage(sessionId: string, paths: string[]): Promise<Result<void>>;
  /** FR-007: `git restore --staged --`, same path-sourcing rule as `stage`. */
  unstage(sessionId: string, paths: string[]): Promise<Result<void>>;
  /** FR-004, 2026-10-20 fix: stages every file CURRENTLY in just the named group ("changes" or
   * "untracked", re-read server-side at call time, never the renderer's own possibly-stale
   * snapshot) -- the two groups used to be chained into one combined stage regardless of which
   * group's own "Stage all" button was clicked; Conflicts is never an eligible group here. */
  stageAll(sessionId: string, group: 'changes' | 'untracked'): Promise<Result<void>>;
  /** FR-004: unstages every file CURRENTLY in the Staged group (re-read server-side). */
  unstageAll(sessionId: string): Promise<Result<void>>;
  /** FR-008: one file's diff body, `git diff` / `git diff --cached` by whether `staged` is
   * true -- the hunk-only patch text `DiffViewFromPatch` (`DiffView.tsx`) already expects (no
   * `diff --git`/`---`/`+++` header lines), never rendered inline inside the hosted pane
   * (the panel's own content area swaps to a diff view, still inside the pane). `untracked`
   * (#1101, item 4): true for a file with no index/HEAD side to diff against at all -- the
   * whole file is synthesised as added lines instead of an empty patch, capped/binary-checked
   * by the same rules `changes_status.rs`'s own numstat/size-cap logic already applies
   * elsewhere in this panel. */
  diff(sessionId: string, path: string, staged: boolean, untracked: boolean): Promise<Result<{ patch: string }>>;
  /** FR-011: `git commit -F -`, the composed message piped on stdin (never `-m`). Rejected
   * locally with `invalid-argument` for a blank (after trimming) message before ever reaching
   * git. FR-013: any failure (including an `index.lock` collision) is a typed `git-failed`
   * error, never auto-retried. */
  commit(sessionId: string, message: string): Promise<Result<void>>;
  /** Mirrors `fileExplorer.stopWatching`/`.ensureWatching` exactly (research.md decision 6):
   * the panel calls `ensureWatching` on mount/Session-focus and `stopWatching` on unmount/
   * blur, so a closed panel's Session is never watched (FR-016). A no-op if already in the
   * requested state. */
  stopWatching(sessionId: string): Promise<Result<void>>;
  ensureWatching(sessionId: string): Promise<Result<void>>;
}
