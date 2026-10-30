//! Shell-free git wrappers and worktree operations.

// `git::git` is intentional; clippy::module_inception would otherwise flag it.
pub mod changes_diff;
pub mod changes_parse;
pub mod changes_score;
pub mod changes_status;
pub mod diff_stat;
#[allow(clippy::module_inception)]
pub mod git;
pub mod pathspec;
pub mod remote;
pub mod status;
#[cfg(test)]
pub(crate) mod test_support;
pub mod worktree_delete;
pub mod worktree_delete_check;
pub mod worktree_holders;
pub mod worktree_validity;
pub mod worktrees;
