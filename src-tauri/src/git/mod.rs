// Rust port of `src/main/git/`: `git.rs` is `git.ts`'s shell-free `execFile` wrapper and typed
// errors; `worktrees.rs` is the slice of `worktrees.ts` milestone 1 needs (repo-validity checks,
// the branch-listing CLI wrapper `repositories.branches` uses, worktree create used by
// `sessions.create`), tasks.md T016.

pub mod git;
pub mod worktrees;
