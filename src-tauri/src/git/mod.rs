// Rust port of `src/main/git/`: `git.rs` is `git.ts`'s shell-free `execFile` wrapper and typed
// errors; `worktrees.rs` is the slice of `worktrees.ts` milestone 1 needs (repo-validity checks,
// the branch-listing CLI wrapper `repositories.branches` uses, worktree create used by
// `sessions.create`), tasks.md T016.

// `git.rs` is named for parity with the Electron build's `git.ts`, not nested by mistake --
// `clippy::module_inception` would otherwise flag `git::git` as a module sharing its parent's
// name.
#[allow(clippy::module_inception)]
pub mod git;
pub mod worktrees;
