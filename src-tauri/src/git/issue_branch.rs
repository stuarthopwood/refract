// Worktree for a Session started from an issue: branch `issue-<n>-<slug>` cut from the default branch.

use std::path::Path;

use super::git::GitError;
use super::worktrees::{add_worktree_with_candidates, default_branch, AddWorktreeResult};

const MAX_SLUG_CHARS: usize = 40;

/// Lower-case ASCII words joined by `-`, capped at 40 characters. Empty for a title with no
/// ASCII letters or digits.
pub fn title_slug(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    slug.truncate(MAX_SLUG_CHARS);
    slug.trim_end_matches('-').to_string()
}

/// `issue-<n>-<slug>`, or `issue-<n>` alone when the slug is empty.
pub fn issue_branch_name(number: u64, title: &str) -> String {
    let slug = title_slug(title);
    if slug.is_empty() {
        format!("issue-{number}")
    } else {
        format!("issue-{number}-{slug}")
    }
}

/// Reserves `issue-<n>-<slug>` (then `-2`, `-3`, ...) atomically, like the pull request path.
pub async fn add_worktree_for_issue(
    repo: &Path,
    number: u64,
    title: &str,
) -> Result<AddWorktreeResult, GitError> {
    let base_branch = default_branch(repo).await?;
    let base = issue_branch_name(number, title);
    const MAX_ATTEMPTS: u32 = 1000;
    let candidates = std::iter::once(base.clone())
        .chain((2..=MAX_ATTEMPTS).map(move |suffix| format!("{base}-{suffix}")));
    add_worktree_with_candidates(repo, &base_branch, candidates).await
}
