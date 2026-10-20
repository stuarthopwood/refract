// Split out of `changes_status.rs` (issue #806, "no god files" -- that file crossed the 600-line
// soft cap once this function landed): the Git changes panel's own single-file diff-text reader
// (spec 018 slice 1, issue #464, FR-008), following `git/mod.rs`'s own established split
// convention (`worktree_delete.rs` out of `worktrees.rs`) -- a behaviour-preserving move, not a
// redesign.

use std::path::Path;
use std::time::Duration;

use super::git::{git_raw, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;

/// Mirrors `changes_status.rs`'s own `DIFF_TIMEOUT`: re-declared rather than imported, since that
/// constant is a private `const` in its own file (same reasoning that file's header comment gives
/// for its own re-declared `diff_stat.rs` constants).
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

/// Mirrors `changes_score.rs`'s own `MAX_FILE_BYTES`/`BINARY_SNIFF_BYTES` (re-declared, not
/// imported -- both are private `const`s in their own file, same reasoning that file's own
/// header comment gives for re-declaring `diff_stat.rs`'s constants in turn).
const UNTRACKED_MAX_FILE_BYTES: u64 = 1024 * 1024;
const UNTRACKED_BINARY_SNIFF_BYTES: usize = 8000;

/// Port of `changes_score.rs`'s own `is_binary` (re-declared, same reasoning as the size cap
/// above).
fn is_binary(buf: &[u8]) -> bool {
    let len = buf.len().min(UNTRACKED_BINARY_SNIFF_BYTES);
    buf[..len].contains(&0)
}

/// #1101 (item 4): an untracked file has no index/HEAD side for `git diff` to compare against,
/// so `diff_text` below always scored it as an empty patch (the renderer's own "No changes"
/// fallback rendering an empty box) -- this synthesises a whole-file-as-additions hunk directly
/// from the file's own content instead, exactly the way `changes_score.rs::score_untracked_file`
/// already caps and binary-checks that SAME file's additions COUNT elsewhere in this panel
/// (never a second, uncapped read path for it). Degrades to `String::new()` for every edge case
/// (vanished, oversized, binary, unreadable) -- the renderer's existing "No changes" fallback
/// already covers an empty patch, the same display case a tracked file with nothing to show
/// already relies on below. Line splitting/counting mirrors `changes_score.rs::count_lines`
/// exactly (CRLF/CR normalised to LF, a lone trailing newline not counted as an extra line) so
/// this hunk's own declared line count always agrees with that already-computed "+N" badge.
async fn untracked_file_patch(worktree_path: &Path, path: &str) -> String {
    let absolute_path = worktree_path.join(path);
    let metadata = match tokio::fs::metadata(&absolute_path).await {
        Ok(metadata) => metadata,
        Err(_) => return String::new(),
    };
    if metadata.len() > UNTRACKED_MAX_FILE_BYTES {
        return String::new();
    }
    let content = match tokio::fs::read(&absolute_path).await {
        Ok(bytes) => bytes,
        Err(_) => return String::new(),
    };
    if is_binary(&content) {
        return String::new();
    }
    let text = String::from_utf8_lossy(&content);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let has_trailing_newline = normalized.ends_with('\n');
    let trimmed = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let mut patch = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for line in &lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !has_trailing_newline {
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

/// FR-008: `git diff` / `git diff --cached` for one file's diff body, by whether it is staged.
/// (same rule as `stage_files`/`unstage_files`, enforced here too by the same
/// `validate_pathspec` backstop, 2026-10-20 security hardening -- never trusts that convention
/// alone, constitution V). Returns just the hunk-only patch text (from the
/// first `@@` line onward) -- the same shape GitHub's REST `patch` field already uses -- so the
/// renderer's existing `DiffViewFromPatch` (`src/renderer/features/chat/DiffView.tsx`, which
/// rebuilds its own `diff --git`/`---`/`+++` header from the path directly) can render it
/// unchanged; the `diff --git`/`index`/`---`/`+++` header lines git itself prints are stripped
/// here so that rebuild is never doubled. `untracked` (#1101, item 4): true for a file with no
/// index/HEAD side to diff against at all -- delegates to `untracked_file_patch` above instead
/// of running `git diff` at all, which would otherwise always score an empty string for it. A
/// binary file still scores an empty string either way (git prints "Binary files ... differ",
/// no `@@` line at all, for a TRACKED binary; `untracked_file_patch`'s own binary sniff covers
/// the untracked case) -- the renderer's own "No changes" fallback covers that display case.
pub async fn diff_text(
    worktree_path: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
) -> Result<String, GitError> {
    validate_pathspec(worktree_path, path)?;
    if untracked {
        return Ok(untracked_file_patch(worktree_path, path).await);
    }
    // Gate round 1 items 9/10 (#464): `--literal-pathspecs`/`-c core.fsmonitor=false` as global
    // options before the subcommand, plus `--no-color`/`--no-optional-locks` on the `diff`
    // itself -- same hardening `changes_status.rs::build_groups`'s own numstat calls get, and
    // same `--no-optional-locks` reasoning as `status.rs`'s own status read (never block on a
    // concurrent agent-held lock). Gate round 2 item 1 (#464): `--no-ext-diff`/`--no-textconv`
    // added on top -- without them a repo's own `diff.external`/`GIT_EXTERNAL_DIFF` config or a
    // pathspec-matched `diff.<driver>.textconv` would run an arbitrary external command every
    // time this panel opens a file's diff, never something a developer asked for just by
    // clicking a changed file. `git.rs::GIT_ENV_VARS_TO_STRIP` strips `GIT_EXTERNAL_DIFF` from
    // every invocation too (belt-and-braces); `--no-ext-diff` alone already suffices here, the
    // env strip only guards a caller that forgets this flag.
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
    ];
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
