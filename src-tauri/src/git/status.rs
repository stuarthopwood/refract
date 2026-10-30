// Git status via one `git_raw` call; `-z` avoids path quoting. Returns `None` on any failure so errors never reach the renderer.
// Precedence: `??`/`!!`, conflicts, rename/copy, delete, add, then `Staged` (index-only) vs `Modified`.
// `GIT_OPTIONAL_LOCKS`/`GIT_TERMINAL_PROMPT` are not set: `git_raw` takes no env; `--no-optional-locks` and the timeout cover it.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::fs::paths::contains_git_segment;
use crate::git::git::git_raw;

const STATUS_GIT_ARGS: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--ignore-submodules=all",
];

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// Output cap: past this, `read_git_status` returns `None` rather than build an unbounded map.
const STATUS_MAX_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// Status mark for a path, mirroring the shared `GitStatusMark`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitStatusMark {
    Modified,
    Added,
    Untracked,
    Deleted,
    Ignored,
    Renamed,
    Conflicted,
    Staged,
}

/// Marks keyed by worktree-relative path; absent means clean. `.git` is never a key.
pub type GitStatusMap = BTreeMap<String, GitStatusMark>;

const CONFLICT_CODES: &[&str] = &["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

fn mark_from_code(code: &str) -> GitStatusMark {
    if code == "??" {
        return GitStatusMark::Untracked;
    }
    if code == "!!" {
        return GitStatusMark::Ignored;
    }
    if CONFLICT_CODES.contains(&code) {
        return GitStatusMark::Conflicted;
    }
    let bytes = code.as_bytes();
    let (x, y) = (bytes[0], bytes[1]);
    // A copy (`C`, under `status.renames=copies`) also carries a from-path field, like a rename.
    if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
        return GitStatusMark::Renamed;
    }
    if x == b'D' || y == b'D' {
        return GitStatusMark::Deleted;
    }
    if x == b'A' || y == b'A' {
        return GitStatusMark::Added;
    }
    if y != b' ' {
        return GitStatusMark::Modified;
    }
    if x != b' ' {
        return GitStatusMark::Staged;
    }
    GitStatusMark::Modified
}

/// Parses `-z` `status --porcelain=v1` output into a `GitStatusMap`.
// Rename/copy entries carry an extra from-path field that must be consumed, else it parses as a status line.
// Slices are `get`-based so a malformed entry is skipped, never a panic.
fn parse_status(stdout: &str) -> GitStatusMap {
    let mut map = GitStatusMap::new();
    let mut tokens = stdout.split('\0');
    while let Some(entry) = tokens.next() {
        if entry.is_empty() {
            continue;
        }
        let Some(code) = entry.get(0..2) else {
            continue;
        };
        let Some(after_code) = entry.get(3..) else {
            continue;
        };
        let file_path = after_code.trim_end_matches('/');
        let code_bytes = code.as_bytes();
        let is_rename_or_copy = code_bytes[0] == b'R'
            || code_bytes[1] == b'R'
            || code_bytes[0] == b'C'
            || code_bytes[1] == b'C';
        if is_rename_or_copy {
            tokens.next(); // renamed/copied-from path: not a map key, `file_path` above is
        }
        if contains_git_segment(file_path) {
            continue; // `.git` itself is never a key
        }
        map.insert(file_path.to_string(), mark_from_code(code));
    }
    map
}

/// Reads git status for the File explorer; `None` past `STATUS_MAX_BUFFER_BYTES`.
// `git_raw` buffers all stdout, so the cap is a post-read guard, not a streaming limit.
pub async fn read_git_status(worktree_path: &Path) -> Option<GitStatusMap> {
    let result = git_raw(worktree_path, STATUS_GIT_ARGS, Some(STATUS_TIMEOUT)).await;
    if result.code != 0 {
        return None;
    }
    if result.stdout.len() > STATUS_MAX_BUFFER_BYTES {
        return None;
    }
    Some(parse_status(&result.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{init_repo, run_git};

    #[test]
    fn untracked_and_ignored_pairs_map_correctly() {
        assert_eq!(mark_from_code("??"), GitStatusMark::Untracked);
        assert_eq!(mark_from_code("!!"), GitStatusMark::Ignored);
    }

    #[test]
    fn unmerged_pairs_map_to_conflicted() {
        for code in CONFLICT_CODES {
            assert_eq!(mark_from_code(code), GitStatusMark::Conflicted, "{code}");
        }
    }

    #[test]
    fn rename_in_either_column_maps_to_renamed() {
        assert_eq!(mark_from_code("R "), GitStatusMark::Renamed);
        assert_eq!(mark_from_code(" R"), GitStatusMark::Renamed);
        assert_eq!(mark_from_code("RM"), GitStatusMark::Renamed);
    }

    #[test]
    fn copy_in_either_column_maps_to_renamed_like_a_rename() {
        assert_eq!(mark_from_code("C "), GitStatusMark::Renamed);
        assert_eq!(mark_from_code(" C"), GitStatusMark::Renamed);
    }

    #[test]
    fn parse_status_consumes_the_copied_from_field_without_keying_it_or_panicking() {
        let stdout = "C  new.txt\0old.txt\0";
        let map = parse_status(stdout);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("new.txt"), Some(&GitStatusMark::Renamed));
        assert!(!map.contains_key("old.txt"));
    }

    #[test]
    fn parse_status_never_panics_on_a_non_ascii_byte_at_an_indexing_boundary() {
        // A malformed/truncated entry (too short to even carry a code) must be skipped, never
        // panic on a `get`-based slice landing off a UTF-8 char boundary.
        let stdout = "\u{1f600}\0?? ok.txt\0";
        let map = parse_status(stdout);
        assert_eq!(map.get("ok.txt"), Some(&GitStatusMark::Untracked));
    }

    #[test]
    fn delete_in_either_column_maps_to_deleted() {
        assert_eq!(mark_from_code("D "), GitStatusMark::Deleted);
        assert_eq!(mark_from_code(" D"), GitStatusMark::Deleted);
    }

    #[test]
    fn add_in_either_column_maps_to_added() {
        assert_eq!(mark_from_code("A "), GitStatusMark::Added);
    }

    #[test]
    fn index_only_modification_is_staged() {
        assert_eq!(mark_from_code("M "), GitStatusMark::Staged);
    }

    #[test]
    fn worktree_modification_is_modified_even_if_also_staged() {
        assert_eq!(mark_from_code(" M"), GitStatusMark::Modified);
        assert_eq!(mark_from_code("MM"), GitStatusMark::Modified);
    }

    #[test]
    fn parse_status_strips_trailing_slash_on_directories() {
        let stdout = "?? newdir/\0!! node_modules/\0";
        let map = parse_status(stdout);
        assert_eq!(map.get("newdir"), Some(&GitStatusMark::Untracked));
        assert_eq!(map.get("node_modules"), Some(&GitStatusMark::Ignored));
    }

    #[test]
    fn parse_status_consumes_the_renamed_from_field_without_keying_it() {
        let stdout = "R  new.txt\0old.txt\0";
        let map = parse_status(stdout);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("new.txt"), Some(&GitStatusMark::Renamed));
        assert!(!map.contains_key("old.txt"));
    }

    #[test]
    fn parse_status_never_keys_dot_git() {
        let stdout = "?? .git/hooks/pre-commit\0";
        let map = parse_status(stdout);
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn a_non_repo_directory_returns_none() {
        let dir =
            std::env::temp_dir().join(format!("refract-status-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        assert!(read_git_status(&dir).await.is_none());
    }

    #[tokio::test]
    async fn a_clean_repo_has_an_empty_map() {
        let repo = init_repo().await;
        let map = read_git_status(&repo).await.expect("clean repo status");
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn an_untracked_file_is_reported() {
        let repo = init_repo().await;
        tokio::fs::write(repo.join("new.txt"), b"hi").await.unwrap();
        let map = read_git_status(&repo).await.expect("status");
        assert_eq!(map.get("new.txt"), Some(&GitStatusMark::Untracked));
    }

    #[tokio::test]
    async fn a_staged_new_file_is_reported_as_staged() {
        let repo = init_repo().await;
        tokio::fs::write(repo.join("new.txt"), b"hi").await.unwrap();
        run_git(&repo, &["add", "new.txt"]).await;
        let map = read_git_status(&repo).await.expect("status");
        // A newly staged, never-before-committed file is `A ` (added), not `M `.
        assert_eq!(map.get("new.txt"), Some(&GitStatusMark::Added));
    }

    #[tokio::test]
    async fn a_committed_file_modified_and_staged_is_staged() {
        let repo = init_repo().await;
        tokio::fs::write(repo.join("README.md"), b"changed\n")
            .await
            .unwrap();
        run_git(&repo, &["add", "README.md"]).await;
        let map = read_git_status(&repo).await.expect("status");
        assert_eq!(map.get("README.md"), Some(&GitStatusMark::Staged));
    }

    #[tokio::test]
    async fn a_committed_file_modified_unstaged_is_modified() {
        let repo = init_repo().await;
        tokio::fs::write(repo.join("README.md"), b"changed\n")
            .await
            .unwrap();
        let map = read_git_status(&repo).await.expect("status");
        assert_eq!(map.get("README.md"), Some(&GitStatusMark::Modified));
    }
}
