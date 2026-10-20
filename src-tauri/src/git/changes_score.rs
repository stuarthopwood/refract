// Split out of `changes_status.rs` (issue #806, "no god files" -- rustfmt's own line-wrapping
// pushed that file back over the 600-line cap): the Git changes panel's own numstat-parsing and
// untracked-file-scoring helpers (spec 018 slice 1, issue #464, FR-019), following `git/mod.rs`'s
// established split convention -- a behaviour-preserving move, not a redesign.

use std::collections::HashMap;
use std::path::Path;

/// Mirrors `diff_stat.rs`'s own `MAX_FILE_BYTES`.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Mirrors `diff_stat.rs`'s own `BINARY_SNIFF_BYTES`.
const BINARY_SNIFF_BYTES: usize = 8000;

/// Port of `diff_stat.rs`'s own `is_binary` (re-declared, see `changes_status.rs`'s own header
/// comment on why this module's constants are re-declared rather than imported across files).
fn is_binary(buf: &[u8]) -> bool {
    let len = buf.len().min(BINARY_SNIFF_BYTES);
    buf[..len].contains(&0)
}

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

/// Parses `git diff [--cached] --no-renames --numstat` output into a path -> (additions,
/// deletions) map. `--no-renames` means a rename/copy always reports as a plain delete (old
/// path) plus add (new path) rather than an `old => new` arrow notation -- a path this map has
/// no entry for (e.g. the discarded old half of a rename) simply scores 0/0/not-partial, same as
/// any other path git's numstat happens not to mention.
pub(super) fn parse_numstat_map(stdout: &str) -> HashMap<String, (i64, i64)> {
    let mut map = HashMap::new();
    for line in stdout.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let mut columns = line.splitn(3, '\t');
        let add_raw = columns.next().unwrap_or("");
        let del_raw = columns.next().unwrap_or("");
        let path = columns.next().unwrap_or("").trim();
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
/// the content at all once its size exceeds `MAX_FILE_BYTES` -- mirrors `diff_stat.rs`'s own
/// `score_untracked_file`, adapted to read straight from disk (this module has no existing
/// `ls-files`-sourced byte buffer to score against).
pub(super) async fn score_untracked_file(
    worktree_path: &Path,
    relative_path: &str,
) -> (i64, i64, bool) {
    let absolute_path = worktree_path.join(relative_path);
    let metadata = match tokio::fs::metadata(&absolute_path).await {
        Ok(metadata) => metadata,
        // Vanished between the status read and this scoring pass; 0/0, not partial -- the row
        // itself still came from a real status entry and stays operable.
        Err(_) => return (0, 0, false),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return (0, 0, true);
    }
    let content = match tokio::fs::read(&absolute_path).await {
        Ok(bytes) => bytes,
        Err(_) => return (0, 0, false),
    };
    if is_binary(&content) {
        return (0, 0, false);
    }
    (count_lines(&String::from_utf8_lossy(&content)), 0, false)
}
