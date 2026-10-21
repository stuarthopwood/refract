// Split out of `changes_status.rs` (issue #806, "no god files" -- rustfmt's own line-wrapping
// pushed that file back over the 600-line cap): the Git changes panel's own numstat-parsing and
// untracked-file-scoring helpers (spec 018 slice 1, issue #464, FR-019), following `git/mod.rs`'s
// established split convention -- a behaviour-preserving move, not a redesign.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::fs::paths::contains_git_segment;
use crate::fs::read_preview::{read_preview, FilePreviewKind};
use crate::fs::resolve::{canonicalize_root, resolve_in_worktree_with_root, ResolveReason};

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

/// #1111 gate round 2 HIGH 1: one untracked path's own containment-proven classification,
/// shared by `changes_diff.rs::untracked_file_patch` and `score_untracked_file` below (gate
/// round 2 MEDIUM 6: the duplicated block in both files is now written and fixed in exactly one
/// place). Never constructed outside this module's own `resolve_untracked_entry`.
pub(super) enum UntrackedEntry {
    /// The leaf itself doesn't exist (vanished between the status scan that produced this path
    /// and this read, or any other reason the final `symlink_metadata` failed) -- a benign race,
    /// not a security event.
    Missing,
    /// The leaf IS a symlink/junction -- `target_text` is its own unresolved target string,
    /// exactly git's own view of an untracked symlink's blob. Never read through.
    Symlink { target_text: String },
    /// The leaf exists but is not a regular file (a directory, FIFO, device node, ...).
    NotAFile,
    /// The leaf is a genuine regular file; `resolved` is its real, already-contained path --
    /// safe to pass to `fs::read_preview::read_preview` or any other direct file read.
    File { resolved: PathBuf },
}

/// #1111 gate round 2 HIGH 1 + MEDIUM 6: resolves `path` against `worktree_path`, proving
/// containment, and classifies its own LEAF (symlink vs regular file vs missing) WITHOUT ever
/// resolving through a symlink at the leaf itself.
///
/// Gate round 1's own fix (`resolve_in_worktree` on the WHOLE path, then `symlink_metadata` on
/// its result) was dead code: `resolve_in_worktree`'s own walk (`dunce::canonicalize`-based)
/// fully resolves every symlink in the chain INCLUDING the final segment, so its result can never
/// itself be a link -- an in-worktree symlink was silently read straight through on every diff/
/// score pass, regressing #1101's own "never read through a symlink" promise and leaving #1110
/// unmet. Fixed: only `path`'s PARENT folder is resolved through the containment walk; the
/// (never independently resolved) LEAF name is then joined onto that real, canonical parent --
/// `symlink_metadata` on THAT joined path classifies the leaf for what it itself is on disk,
/// never for what following a chain through it would resolve to.
///
/// `.git` is refused both as a raw segment of the as-typed `path` (before any resolution) and
/// again on the final joined path relative to the canonicalized worktree root (catches a Windows
/// 8.3 short name or trailing-dot alias that only resolves to `.git` after the fact) --
/// `fs::list_directory::resolve_list_target`'s own two-step check, mirrored here. Gate round 2
/// MEDIUM 6: the worktree root is canonicalized exactly ONCE per call (`canonicalize_root`, then
/// `resolve_in_worktree_with_root` for the parent -- never a second, redundant canonicalize for
/// the same containment proof), and a `strip_prefix` failure REFUSES (`OutsideWorktree`) instead
/// of the previous `unwrap_or_default()`, which silently produced an EMPTY relative path on any
/// such failure -- trivially passing the `.git`-segment check and skipping the whole
/// post-resolution guard, a fail-OPEN bug.
pub(super) async fn resolve_untracked_entry(
    worktree_path: &Path,
    path: &str,
) -> Result<UntrackedEntry, ResolveReason> {
    if contains_git_segment(path) {
        return Err(ResolveReason::OutsideWorktree);
    }
    let (parent, leaf) = path.rsplit_once('/').unwrap_or(("", path));
    let root_real = canonicalize_root(worktree_path).await?;
    let resolved_parent = if parent.is_empty() {
        root_real.clone()
    } else {
        resolve_in_worktree_with_root(&root_real, worktree_path, parent).await?
    };
    let resolved = resolved_parent.join(leaf);
    let rel_from_root = resolved
        .strip_prefix(&root_real)
        .map_err(|_| ResolveReason::OutsideWorktree)?
        .to_string_lossy()
        .replace('\\', "/");
    if contains_git_segment(&rel_from_root) {
        return Err(ResolveReason::OutsideWorktree);
    }
    let link_metadata = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(metadata) => metadata,
        Err(_) => return Ok(UntrackedEntry::Missing),
    };
    if link_metadata.file_type().is_symlink() {
        return Ok(match tokio::fs::read_link(&resolved).await {
            Ok(target) => UntrackedEntry::Symlink {
                target_text: target.to_string_lossy().replace('\\', "/"),
            },
            Err(_) => UntrackedEntry::Missing,
        });
    }
    if !link_metadata.is_file() {
        return Ok(UntrackedEntry::NotAFile);
    }
    Ok(UntrackedEntry::File { resolved })
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
/// names, just to paint a badge). Fixed to share `resolve_untracked_entry`'s own containment
/// proof and leaf classification: a symlink scores one line (git's own view) without ever being
/// read through; a genuine file is then read through the SAME shared, bounded
/// `fs::read_preview::read_preview` reader `changes_diff.rs::untracked_file_patch` uses, instead
/// of this module's own now-removed second hand-rolled `is_binary`/`MAX_FILE_BYTES` copy of that
/// exact logic.
pub(super) async fn score_untracked_file(
    worktree_path: &Path,
    relative_path: &str,
) -> (i64, i64, bool) {
    let entry = match resolve_untracked_entry(worktree_path, relative_path).await {
        Ok(entry) => entry,
        // A resolve/containment failure (an escape, a vanished parent, ...) degrades the same
        // way either way: 0/0, not partial -- the row itself still came from a real status entry
        // and stays operable, and an escape is never read to produce a real count regardless of
        // why resolution failed.
        Err(_) => return (0, 0, false),
    };
    match entry {
        UntrackedEntry::Missing | UntrackedEntry::NotAFile => (0, 0, false),
        UntrackedEntry::Symlink { .. } => (1, 0, false),
        UntrackedEntry::File { resolved } => {
            let preview = read_preview(&resolved, relative_path).await;
            match preview.kind {
                FilePreviewKind::Text | FilePreviewKind::Markdown => {
                    (count_lines(&preview.content.unwrap_or_default()), 0, false)
                }
                FilePreviewKind::TooLarge => (0, 0, true),
                // Binary, a vanished-mid-read race, a read error, or an image: scores
                // 0/0/not-partial, the same "nothing countable" degrade the pre-existing binary/
                // vanished cases already used -- this is a badge count, not the diff-reason
                // surface `changes_diff.rs` exposes.
                FilePreviewKind::Binary
                | FilePreviewKind::Deleted
                | FilePreviewKind::ReadError
                | FilePreviewKind::Image => (0, 0, false),
            }
        }
    }
}
