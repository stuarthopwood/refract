// Split out of `changes_status.rs` (issue #806, "no god files" -- rustfmt's own line-wrapping
// pushed that file back over the 600-line cap): the Git changes panel's own numstat-parsing and
// untracked-file-scoring helpers (spec 018 slice 1, issue #464, FR-019), following `git/mod.rs`'s
// established split convention -- a behaviour-preserving move, not a redesign.

use std::collections::HashMap;
use std::path::Path;

use crate::fs::paths::contains_git_segment;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{canonicalize_root, resolve_in_worktree};

/// Port of `diff_stat.rs`'s own `count_lines`.
fn count_lines(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if trimmed.is_empty() {
        return 0;
    }
    trimmed.split('\n').count() as i64
}

/// Parses `git diff [--cached] --no-renames --numstat -z` output into a path -> (additions,
/// deletions) map (gate round 1 item 10, issue #464): records are NUL-terminated, not
/// newline-terminated, in the shape `<added>\t<deleted>\t<path>\0` -- `-z` disables git's own
/// C-style quoting of a path with unusual bytes (a literal `[id].txt`, or a non-ASCII name), so
/// the raw bytes between NULs ARE the real path verbatim; the path field is therefore never
/// `.trim()`ed here (the whole point of `-z` would otherwise be defeated). A genuine `-z`
/// RENAME numstat record has a SECOND NUL-terminated field (`<old-path>\0`) right after the
/// first -- but every caller of this function already passes `--no-renames`, so that second-field
/// shape can never occur; this parser trusts that convention rather than defensively sniffing
/// for it, same as `--no-renames`'s own existing doc comment below. `--no-renames` means a
/// rename/copy always reports as a plain delete (old path) plus add (new path) rather than an
/// `old => new` arrow notation -- a path this map has no entry for (e.g. the discarded old half
/// of a rename) simply scores 0/0/not-partial, same as any other path git's numstat happens not
/// to mention.
pub(super) fn parse_numstat_map(stdout: &str) -> HashMap<String, (i64, i64)> {
    let mut map = HashMap::new();
    for record in stdout.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, '\t');
        let add_raw = columns.next().unwrap_or("");
        let del_raw = columns.next().unwrap_or("");
        let path = columns.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let additions = if add_raw != "-" {
            add_raw.parse::<i64>().unwrap_or(0)
        } else {
            0
        };
        let deletions = if del_raw != "-" {
            del_raw.parse::<i64>().unwrap_or(0)
        } else {
            0
        };
        map.insert(path.to_string(), (additions, deletions));
    }
    map
}

/// Scores one untracked file directly from its own content (there is no index/HEAD side to diff
/// against): every line counts as an addition, 0 deletions, `partial: true` instead of reading
/// the content at all once its size exceeds the shared 1 MiB cap. Called on EVERY status
/// refresh (file-watcher-triggered, not just when a diff is opened), unlike
/// `changes_diff.rs::untracked_file_patch` (only called when a diff is actually opened) -- issue
/// #1110: this used to be the one read path in the Git changes panel `untracked_file_patch`'s own
/// #1101 gate-round-1 containment fix never touched, so `tokio::fs::metadata`/`::read` here still
/// followed a symlink/junction straight through with no containment check at all, on every single
/// refresh, purely to compute a `+N` line-count badge (a real risk on Windows: an untracked
/// symlink's target can be a UNC path, triggering an SMB/NTLM round trip against whatever host it
/// names, just to paint a badge). Fixed to mirror `untracked_file_patch`'s own containment proof
/// exactly: `.git` refused both as the raw token and on the resolved path (same two-step check
/// `fs::list_directory::resolve_list_target` uses), `fs::resolve::resolve_in_worktree` proves the
/// whole chain never escapes the worktree before anything is opened, `symlink_metadata` (never
/// `metadata`) detects a symlink and scores it as a single line -- git's own view of an untracked
/// symlink IS its target string -- without ever reading through it to whatever that target names,
/// local or remote. A genuine file is then read through the SAME shared, bounded
/// `fs::read_preview::read_preview` reader `changes_diff.rs::untracked_file_patch` uses, instead
/// of this module's own now-removed second hand-rolled `is_binary`/`MAX_FILE_BYTES` copy of that
/// exact logic.
pub(super) async fn score_untracked_file(
    worktree_path: &Path,
    relative_path: &str,
) -> (i64, i64, bool) {
    if contains_git_segment(relative_path) {
        return (0, 0, false);
    }
    // A resolve failure (vanished between the status read and this scoring pass, OR an escaping
    // symlink/junction) degrades the same way either way: 0/0, not partial -- the row itself
    // still came from a real status entry and stays operable, and an escape is never read to
    // produce a real count regardless of why resolution failed.
    let resolved = match resolve_in_worktree(worktree_path, relative_path).await {
        Ok(resolved) => resolved,
        Err(_) => return (0, 0, false),
    };
    let root_real = canonicalize_root(worktree_path)
        .await
        .unwrap_or_else(|_| worktree_path.to_path_buf());
    let rel_from_root = resolved
        .strip_prefix(&root_real)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if contains_git_segment(&rel_from_root) {
        return (0, 0, false);
    }
    let link_metadata = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(metadata) => metadata,
        Err(_) => return (0, 0, false),
    };
    if link_metadata.file_type().is_symlink() {
        return (1, 0, false);
    }
    if !link_metadata.is_file() {
        return (0, 0, false);
    }
    let preview = read_preview(&resolved, relative_path).await;
    match preview.kind {
        FilePreviewKind::Text | FilePreviewKind::Markdown => {
            (count_lines(&preview.content.unwrap_or_default()), 0, false)
        }
        FilePreviewKind::TooLarge => (0, 0, true),
        // Binary, a vanished-mid-read race, a read error, or an image: scores 0/0/not-partial,
        // the same "nothing countable" degrade the pre-existing binary/vanished cases already
        // used -- this is a badge count, not the diff-reason surface `changes_diff.rs` exposes.
        FilePreviewKind::Binary
        | FilePreviewKind::Deleted
        | FilePreviewKind::ReadError
        | FilePreviewKind::Image => (0, 0, false),
    }
}
