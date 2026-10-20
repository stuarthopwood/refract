// Split out of `changes_status.rs` (issue #806, "no god files" -- that file crossed the 600-line
// soft cap once this function landed): the Git changes panel's own single-file diff-text reader
// (spec 018 slice 1, issue #464, FR-008), following `git/mod.rs`'s own established split
// convention (`worktree_delete.rs` out of `worktrees.rs`) -- a behaviour-preserving move, not a
// redesign.

use std::path::Path;
use std::time::Duration;

use super::git::{git_raw, GitError, GitErrorCode};

/// Mirrors `changes_status.rs`'s own `DIFF_TIMEOUT`: re-declared rather than imported, since that
/// constant is a private `const` in its own file (same reasoning that file's header comment gives
/// for its own re-declared `diff_stat.rs` constants).
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

/// FR-008: `git diff` / `git diff --cached` for one file's diff body, by whether it is staged.
/// `path` is a literal post-`--` argv entry, sourced only from the current status map's own keys
/// (same rule as `stage_files`/`unstage_files`). Returns just the hunk-only patch text (from the
/// first `@@` line onward) -- the same shape GitHub's REST `patch` field already uses -- so the
/// renderer's existing `DiffViewFromPatch` (`src/renderer/features/chat/DiffView.tsx`, which
/// rebuilds its own `diff --git`/`---`/`+++` header from the path directly) can render it
/// unchanged; the `diff --git`/`index`/`---`/`+++` header lines git itself prints are stripped
/// here so that rebuild is never doubled. An untracked file (no index/HEAD side to diff against)
/// or a binary file (git prints "Binary files ... differ", no `@@` line at all) both score an
/// empty string -- the renderer's own "No changes" fallback covers that display case.
pub async fn diff_text(worktree_path: &Path, path: &str, staged: bool) -> Result<String, GitError> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    let result = git_raw(worktree_path, &args, Some(DIFF_TIMEOUT)).await;
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else {
            result.stdout.trim()
        };
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            format!("git {} failed: {detail}", args.join(" ")),
        ));
    }
    match result.stdout.find("\n@@") {
        Some(at) => Ok(result.stdout[at + 1..].to_string()),
        None => Ok(String::new()),
    }
}
