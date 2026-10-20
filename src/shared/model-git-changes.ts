// Git changes panel wire shapes (spec 018 slice 1, issue #464), split out of `model.ts` to keep
// that file at its own file-size baseline (issue #806, `scripts/check-file-size.mjs`) -- pure
// extraction, no behaviour change, same precedent `ipc-attachments.ts`/`ipc-model.ts` already set
// for `ipc.ts`.

import type { GitStatusMark } from './model';

/** Spec 018 slice 1 (data-model.md "Git changes group"), issue #464: the four fixed buckets
 * every non-ignored `git status --porcelain=v2` entry sorts into exactly once (FR-002). */
export type GitChangesGroupKind = 'conflicts' | 'staged' | 'changes' | 'untracked';

/** Spec 018 slice 1 (data-model.md "Git changes file row"): one path's display state for the
 * Git changes panel -- `folder` is the path's own POSIX-relative containing directory (`''` for
 * a top-level entry, matching `FileTreeNode.path`'s own convention, FR-005). `mark` reuses
 * `GitStatusMark` unchanged (research.md decision 2); `additions`/`deletions` follow
 * `diff_stat.rs`'s own `MAX_FILES` cap, `partial` marking THIS file's own count as not fully
 * computed (FR-019) -- the row itself still renders and is still fully operable either way. */
export interface GitChangesFileEntry {
  path: string;
  folder: string;
  mark: GitStatusMark;
  additions: number;
  deletions: number;
  partial: boolean;
}

/** Spec 018 slice 1 (data-model.md "Git changes header", FR-014): the panel's own branch-line
 * data, reusing `SessionDetailsCard.tsx`'s branch-line shape (`GitBranchIcon` + branch + muted
 * "from {base}"). `baseBranch` is the Session's own already-stored `Session.baseBranch`, never
 * re-derived from git status. `aheadBehind` is `null` when there is no upstream -- the ahead/
 * behind figure is then entirely omitted, never shown as `0`/`0`. */
export interface GitChangesHeader {
  branch: string;
  baseBranch: string;
  aheadBehind: { ahead: number; behind: number } | null;
}

/** Spec 018 slice 1: `gitChanges.list`'s own return shape -- the panel's whole state in one
 * call (header plus every group's own file rows, each group's count derivable from its own
 * array length). */
export interface GitChangesSnapshot {
  header: GitChangesHeader;
  groups: Record<GitChangesGroupKind, GitChangesFileEntry[]>;
}
