/** `sessions.deleteLeftoverSummary` result: a `git status --ignored` read of the worktree.
 * `unavailable` means the git call failed or timed out, distinct from an empty worktree. */
export interface LeftoverSummary {
  rootName: string;
  generatedFolders: { name: string; fileCount: number }[];
  otherFiles: string[];
  moreCount: number;
  unavailable: boolean;
}
