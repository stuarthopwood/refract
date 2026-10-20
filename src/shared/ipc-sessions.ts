// Issue #891's `sessions.deleteLeftoverSummary` result type, split into its own file to keep
// `ipc.ts` at its existing file-size baseline (issue #806, `scripts/check-file-size.mjs`) -- pure
// extraction, no existing export moves, same precedent `ipc-model.ts`/`ipc-attachments.ts`
// already set.

/** `sessions.deleteLeftoverSummary` (issue #891): a background `git status --ignored` read of
 * the worktree (gate round 1: not a raw filesystem walk -- tracked files and `.git` are never
 * listed), separate from `deleteCheck`'s own uncommitted/unpushed stats. Lists generated
 * folders (e.g. `node_modules`) by name with a combined file count, and other files by path,
 * capped with `moreCount` once there are too many to list individually. `rootName` (gate round,
 * M3) is the worktree folder's own basename, so the renderer can lead each displayed path with
 * which Session it belongs to. `unavailable` (gate round 2, H2) is true when the underlying
 * `git status` call failed, timed out, or its own join failed -- distinct from a genuinely
 * empty worktree; the dialog must show "Couldn't list the folder's files." in that case, never
 * fold it into "Nothing left in the worktree". */
export interface LeftoverSummary {
  rootName: string;
  generatedFolders: { name: string; fileCount: number }[];
  otherFiles: string[];
  moreCount: number;
  unavailable: boolean;
}
