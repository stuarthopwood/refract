// Split out of `changes_status.rs` (issue #806, "no god files" -- that file crossed the 600-line
// soft cap once this function landed): the Git changes panel's own single-file diff-text reader
// (spec 018 slice 1, issue #464, FR-008), following `git/mod.rs`'s own established split
// convention (`worktree_delete.rs` out of `worktrees.rs`) -- a behaviour-preserving move, not a
// redesign.

use std::path::Path;
use std::time::Duration;

use super::changes_score::{resolve_untracked_entry, UntrackedEntry};
use super::git::{git_raw, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{resolve_reason_message, ResolveReason};

/// Mirrors `changes_status.rs`'s own `DIFF_TIMEOUT`: re-declared rather than imported, since that
/// constant is a private `const` in its own file (same reasoning that file's header comment gives
/// for its own re-declared `diff_stat.rs` constants).
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

/// #1111 item 5: a reason `untracked_file_patch` could not render a file's content as an
/// all-additions patch -- the renderer (`src/renderer/features/chat/DiffView.tsx`'s
/// `DiffViewFromPatch`) shows this text instead of its own otherwise-indistinguishable "No
/// changes" fallback whenever `patch` comes back empty for one of these reasons rather than a
/// genuinely empty (0-byte) file.
const REASON_BINARY: &str = "Binary file";
const REASON_IMAGE: &str = "Image file";
const REASON_TOO_LARGE: &str = "Too large to preview (over 1 MiB)";
const REASON_READ_ERROR: &str = "Couldn't read this file";

/// #1101 gate round 1 HIGH 1(e): never trusts the renderer's own `untracked` flag alone -- an
/// independent `git ls-files` read checks the path appears in git's own untracked list before
/// `untracked_file_patch` below ever reads the filesystem directly. #1111 item 1 correction: a
/// match here is advisory, never a containment proof -- that proof is
/// `resolve_untracked_entry`'s own job, run unconditionally inside `untracked_file_patch`
/// regardless of what this check returns. Low item (#1111, round 1): used to accept ANY
/// non-empty output (a folder path, or a path with `.`/backslash variants, also matched that
/// way) -- narrowed to an EXACT line match. Gate round 2 HIGH 2: that line-based exact match
/// itself broke on any non-ASCII path (`café.txt`) -- git's default `core.quotepath` C-quotes
/// anything outside the printable-ASCII range in its own newline-delimited output (`"caf\303\251.
/// txt"`, octal-escaped UTF-8 bytes, never matching a plain `café.txt` string comparison). `-z`
/// disables that quoting entirely and NUL-delimits each record instead of newline-delimiting it
/// -- the exact same fix `changes_score.rs::parse_numstat_map`'s own doc comment already
/// documents for the identical git quoting behaviour, applied here too. A `false` result (no
/// exact match) falls through to the ordinary tracked-file `git diff` path in `diff_text` below
/// -- the correct degrade for a client that raced or simply lied, never a hard refusal.
async fn confirm_untracked(worktree_path: &Path, path: &str) -> bool {
    let result = git_raw(
        worktree_path,
        &[
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "--no-optional-locks",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--",
            path,
        ],
        Some(DIFF_TIMEOUT),
    )
    .await;
    if result.code != 0 {
        return false;
    }
    let normalized = path.replace('\\', "/");
    result
        .stdout
        .split('\0')
        .any(|record| !record.is_empty() && record == normalized)
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
/// #1111 gate round 2 HIGH 1 + MEDIUM 6: containment proof and leaf classification (symlink vs
/// regular file vs missing vs the post-resolution `.git` check) are now `changes_score.rs::
/// resolve_untracked_entry`'s own job, shared verbatim with `score_untracked_file` -- see that
/// function's own doc comment for the full "parent resolved, leaf never independently resolved"
/// reasoning and the fail-closed `strip_prefix` fix. A symlink/junction leaf renders the way
/// `git` itself would store it (an untracked symlink's blob IS its own target string) -- the
/// link's target text as a single added line, NEVER the target's contents. A directory or other
/// special node at the leaf scores an empty patch, the same "nothing to show" degrade as a
/// vanished file.
/// Reads a genuine file through `fs::read_preview::read_preview` -- the SAME bounded (1 MiB cap,
/// matching `changes_score.rs::score_untracked_file`'s own cap), single-file-handle, binary-safe
/// reader `FilePreviewPane.tsx` already uses, instead of a fourth hand-rolled copy of that exact
/// logic. #1111 item 5 / gate round 2 HIGH 3: a binary, image, over-cap, or unreadable file (or
/// the whole read timing out) returns its own reason string alongside the empty patch, instead of
/// an empty patch indistinguishable from a genuinely empty file -- `diff_text` and the IPC
/// handler both thread it straight through to the renderer.
///
/// Gate round 2 MEDIUM 10: the gap between `resolve_untracked_entry`'s own final
/// `symlink_metadata` check and `read_preview`'s subsequent `File::open` is NARROWED (never
/// fully closed, and never claimed to be) compared to the pre-#1111 form, which opened the
/// UNRESOLVED, lexically-joined path directly with no containment proof at all -- reviewers
/// judged the remaining window acceptable for this threat model (a same-user local writer, on
/// the order of 1 ms, bounded to at most 1 MiB by `read_preview`'s own cap, and surfaced only as
/// rendered diff text in this UI, never written anywhere or otherwise exfiltrated).
async fn untracked_file_patch(
    worktree_path: &Path,
    path: &str,
) -> Result<(String, Option<&'static str>), GitError> {
    let read = async {
        let entry = match resolve_untracked_entry(worktree_path, path).await {
            Ok(entry) => entry,
            Err(reason) => return Err(map_resolve_reason(reason)),
        };
        match entry {
            UntrackedEntry::Missing | UntrackedEntry::NotAFile => Ok((String::new(), None)),
            UntrackedEntry::Symlink { target_text } => {
                Ok((format!("@@ -0,0 +1,1 @@\n+{target_text}\n"), None))
            }
            UntrackedEntry::File { resolved } => {
                let preview = read_preview(&resolved, path).await;
                match preview.kind {
                    FilePreviewKind::Text | FilePreviewKind::Markdown => Ok((
                        build_added_patch(&preview.content.unwrap_or_default()),
                        None,
                    )),
                    FilePreviewKind::Binary => Ok((String::new(), Some(REASON_BINARY))),
                    FilePreviewKind::Image => Ok((String::new(), Some(REASON_IMAGE))),
                    FilePreviewKind::TooLarge => Ok((String::new(), Some(REASON_TOO_LARGE))),
                    FilePreviewKind::ReadError => Ok((String::new(), Some(REASON_READ_ERROR))),
                    // A vanished-mid-read race degrades the same as the symlink-target-vanished/
                    // directory cases above (no reason -- it's a race, not a real refusal).
                    FilePreviewKind::Deleted => Ok((String::new(), None)),
                }
            }
        }
    };
    tokio::time::timeout(DIFF_TIMEOUT, read)
        .await
        .unwrap_or_else(|_| Ok((String::new(), Some(REASON_READ_ERROR))))
}

/// FR-008: `git diff` / `git diff --cached` for one file's diff body, by whether it is staged.
/// (same rule as `stage_files`/`unstage_files`, enforced here too by the same
/// `validate_pathspec` backstop, 2026-10-20 security hardening -- never trusts that convention
/// alone, constitution V). Returns the hunk-only patch text (from the first `@@` line onward,
/// the same shape GitHub's REST `patch` field already uses) alongside an optional reason (#1111
/// item 5) for why an untracked file's own patch came back empty, so the renderer's existing
/// `DiffViewFromPatch` (`src/renderer/features/chat/DiffView.tsx`, which rebuilds its own
/// `diff --git`/`---`/`+++` header from the path directly) can render it unchanged; the
/// `diff --git`/`index`/`---`/`+++` header lines git itself prints are stripped here so that
/// rebuild is never doubled. `untracked` (#1101, item 4): true for a file with no index/HEAD side
/// to diff against at all -- re-confirmed server-side (`confirm_untracked`, gate round 1 HIGH
/// 1(e): never the renderer's own flag alone) before delegating to `untracked_file_patch` above;
/// a stale/incorrect flag falls through to the ordinary tracked-file path below instead of ever
/// being trusted. A binary TRACKED file still scores an empty string with no reason either way
/// (git prints "Binary files ... differ", no `@@` line at all) -- only the untracked path (c)
/// above ever has a reason to give.
pub async fn diff_text(
    worktree_path: &Path,
    path: &str,
    staged: bool,
    untracked: bool,
) -> Result<(String, Option<&'static str>), GitError> {
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
        Some(at) => Ok((result.stdout[at + 1..].to_string(), None)),
        None => Ok((String::new(), None)),
    }
}
