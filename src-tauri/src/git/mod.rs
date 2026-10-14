// Rust port of `src/main/git/`: `git.rs` is `git.ts`'s shell-free `execFile` wrapper and typed
// errors; `worktrees.rs` is the slice of `worktrees.ts` milestone 1 needs (repo-validity checks,
// the branch-listing CLI wrapper `repositories.branches` uses, worktree create used by
// `sessions.create`), tasks.md T016. `worktree_delete.rs`/`worktree_validity.rs` (lane R2,
// #785) are the issue #599 safe-delete path and the issue #729 `worktree_is_valid` check,
// split out of `worktrees.rs` to stay under the 600-line soft cap per file.

// `git.rs` is named for parity with the Electron build's `git.ts`, not nested by mistake --
// `clippy::module_inception` would otherwise flag `git::git` as a module sharing its parent's
// name.
pub mod diff_stat;
#[allow(clippy::module_inception)]
pub mod git;
pub mod remote;
pub mod status;
pub mod worktree_delete;
pub mod worktree_validity;
pub mod worktrees;
