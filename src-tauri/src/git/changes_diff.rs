// Split out of `changes_status.rs` (issue #806, "no god files" -- that file crossed the 600-line
// soft cap once this function landed): the Git changes panel's own single-file diff-text reader
// (spec 018 slice 1, issue #464, FR-008), following `git/mod.rs`'s own established split
// convention (`worktree_delete.rs` out of `worktrees.rs`) -- a behaviour-preserving move, not a
// redesign.

use std::path::Path;
use std::time::Duration;

use super::git::{git_raw, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{resolve_in_worktree, resolve_reason_message, ResolveReason};

/// Mirrors `changes_status.rs`'s own `DIFF_TIMEOUT`: re-declared rather than imported, since that
/// constant is a private `const` in its own file (same reasoning that file's header comment gives
/// for its own re-declared `diff_stat.rs` constants).
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

/// #1101 gate round 1 HIGH 1(e): never trusts the renderer's own `untracked` flag alone -- a
/// second, independent `git ls-files` read confirms the path really is untracked server-side
/// before `untracked_file_patch` below ever reads the filesystem directly. Same hardening flags
/// as every other read in this module (`--literal-pathspecs`, `core.fsmonitor=false`,
/// `--no-optional-locks`). A `false` result (anything other than a clean, non-empty match) falls
/// through to the ordinary tracked-file `git diff` path in `diff_text` below -- the correct
/// degrade for a client that raced or simply lied, never a hard refusal.
async fn confirm_untracked(worktree_path: &Path, path: &str) -> bool {
    let result = git_raw(
        worktree_path,
        &[
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "--no-optional-locks",
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            path,
        ],
        Some(DIFF_TIMEOUT),
    )
    .await;
    result.code == 0 && !result.stdout.trim().is_empty()
}

/// Maps a `fs::resolve::ResolveReason` into this module's own `GitError` shape. `OutsideWorktree`
/// reuses the identical `outside-worktree` wire code `validate_pathspec`'s own refusal already
/// returns; the two disk-state reasons (`WorktreeMissing`/`FileMissing`) have no dedicated
/// `GitErrorCode` of their own -- both are rare, race-only outcomes here (the status read that
/// produced this row already saw the file moments earlier), so they fold onto the existing
/// `GitFailed` code with `resolve_reason_message`'s own accurate text rather than adding two
/// single-use variants for one caller.
fn map_resolve_reason(reason: ResolveReason) -> GitError {
    let code = match reason {
        ResolveReason::OutsideWorktree => GitErrorCode::OutsideWorktree,
        ResolveReason::WorktreeMissing | ResolveReason::FileMissing => GitErrorCode::GitFailed,
    };
    GitError::new(code, resolve_reason_message(reason, "file"))
}

/// Gate round 1 LOW 5: normalises CRLF/CR to LF in ONE pass over the content (replacing the
/// previous two sequential whole-string `.replace("\r\n", "\n").replace('\r', "\n")` calls, each
/// of which allocated a full copy).
fn normalize_newlines(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push('\n');
        } else {
            normalized.push(c);
        }
    }
    normalized
}

/// Splits already-read file content into a `+`-prefixed hunk, mirroring
/// `changes_score.rs::count_lines` exactly (a lone trailing newline not counted as an extra line)
/// so this hunk's own declared line count always agrees with that already-computed "+N" badge.
fn build_added_patch(content: &str) -> String {
    let normalized = normalize_newlines(content);
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

/// #1101 (item 4), gate round 1 HIGH 1 hardening: an untracked file has no index/HEAD side for
/// `git diff` to compare against, so `diff_text` below always scored it as an empty patch (the
/// renderer's own "No changes" fallback rendering an empty box) -- this synthesises a whole-
/// file-as-additions hunk directly from the file's own content instead, wrapped in ONE
/// `DIFF_TIMEOUT` for the whole read (item d).
///
/// (a) Resolves through `fs::resolve::resolve_in_worktree` first -- the SAME disk-aware,
/// symlink-chain-walking containment proof `ipc::file_explorer::file_explorer_read_preview`
/// already uses, rather than `validate_pathspec`'s own purely lexical check (which cannot see a
/// directory component that is itself a symlink/junction pointing outside the worktree -- a real
/// gap for THIS function alone, since it is the one path in this module that reads raw file bytes
/// directly rather than letting `git` operate on its own already-contained blobs). Its resolved
/// value is discarded -- it exists purely to prove the whole chain is safely contained (an escape
/// anywhere along it returns `Err` and this function never touches the filesystem at all).
/// (b) Checks `symlink_metadata` on the entry's OWN (pre-resolution, lexically-joined) path: a
/// symlink is rendered the way `git` itself would store it (an untracked symlink's blob IS its
/// own target string) -- the link's target text as a single added line, NEVER the target's
/// contents, regardless of what (a) proved about that target. Requires `is_file()` on anything
/// else (a directory or other special node scores an empty patch, the same "nothing to show"
/// degrade as a vanished file).
/// (c) Reads through `fs::read_preview::read_preview` -- the SAME bounded (1 MiB cap, matching
/// `changes_score.rs::score_untracked_file`'s own cap), single-file-handle, binary-safe reader
/// `FilePreviewPane.tsx` already uses, instead of a fourth hand-rolled copy of that exact logic.
async fn untracked_file_patch(worktree_path: &Path, path: &str) -> Result<String, GitError> {
    let read = async {
        if let Err(reason) = resolve_in_worktree(worktree_path, path).await {
            return Err(map_resolve_reason(reason));
        }
        let entry_path = worktree_path.join(path);
        let link_metadata = match tokio::fs::symlink_metadata(&entry_path).await {
            Ok(metadata) => metadata,
            Err(_) => return Ok(String::new()),
        };
        if link_metadata.file_type().is_symlink() {
            let target = match tokio::fs::read_link(&entry_path).await {
                Ok(target) => target,
                Err(_) => return Ok(String::new()),
            };
            let target_text = target.to_string_lossy().replace('\\', "/");
            return Ok(format!("@@ -0,0 +1,1 @@\n+{target_text}\n"));
        }
        if !link_metadata.is_file() {
            return Ok(String::new());
        }
        let preview = read_preview(&entry_path, path).await;
        let content = match preview.kind {
            FilePreviewKind::Text | FilePreviewKind::Markdown => {
                preview.content.unwrap_or_default()
            }
            _ => return Ok(String::new()),
        };
        Ok(build_added_patch(&content))
    };
    tokio::time::timeout(DIFF_TIMEOUT, read)
        .await
        .unwrap_or_else(|_| Ok(String::new()))
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
/// index/HEAD side to diff against at all -- re-confirmed server-side (`confirm_untracked`, gate
/// round 1 HIGH 1(e): never the renderer's own flag alone) before delegating to
/// `untracked_file_patch` above; a stale/incorrect flag falls through to the ordinary
/// tracked-file path below instead of ever being trusted. A binary file still scores an empty
/// string either way (git prints "Binary files ... differ", no `@@` line at all, for a TRACKED
/// binary; `untracked_file_patch`'s own binary check via `read_preview` covers the untracked
/// case) -- the renderer's own "No changes" fallback covers that display case.
pub async fn diff_text(
    worktree_path: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
) -> Result<String, GitError> {
    validate_pathspec(worktree_path, path)?;
    if untracked && confirm_untracked(worktree_path, path).await {
        return untracked_file_patch(worktree_path, path).await;
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
