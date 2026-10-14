// Port of `src/main/git/status.ts` (lane R7, issue #790): answers "what does this working tree
// look like against HEAD right now" (modified/added/untracked/deleted/ignored). One `git_raw`
// call (`-c core.fsmonitor=false -c core.untrackedCache=false --no-optional-locks status
// --porcelain=v1 -z --ignored=matching --ignore-submodules=all`) answers both the status-mark
// and the ignore-handling question, `-z` NUL-delimits entries with no C-style path quoting.
// Returns `None` on any failure (missing worktree, git failure, timeout) so main never throws
// this into the renderer, matching `diff_stat.rs`'s own convention.
//
// Issue #768 ("extended git status marks"): unlike the TS original's five-value
// `modified | added | untracked | deleted | ignored` collapse (a rename maps to `added`, a
// conflict or a staged-vs-worktree distinction is lost entirely), this port keeps **renamed**,
// **conflicted**, and **staged** distinct from the start -- the shared `GitStatusMark` type
// (`src/shared/model.ts`) is extended once for this and the future Git panel (#464), instead of
// porting the bug and fixing it twice. Precedence (checked in order): untracked/ignored (the `??`
// /`!!` special pairs) first; then the standard porcelain v1 unmerged-path codes (`DD`, `AU`,
// `UD`, `UA`, `DU`, `AA`, `UU`) as `Conflicted`; then a rename (`R` in either column) as
// `Renamed`; then a delete or an add; then, for a plain modify, `Staged` when only the index
// column changed (nothing in the worktree column) versus `Modified` when the worktree column
// itself differs (the state most relevant to a file browser showing live content).
//
// Not ported: the belt-and-suspenders `GIT_OPTIONAL_LOCKS=0`/`GIT_TERMINAL_PROMPT=0` env vars
// (`git::git::git_raw` takes no custom env, only a timeout -- `--no-optional-locks` alone already
// covers the lock question for THIS invocation, and the existing 10s timeout already fails safe
// against a hung credential prompt; recorded as a PR decision, not silently dropped).

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

/// Same shape as `src/shared/model.ts`'s `GitStatusMark`, extended per issue #768 with
/// `Renamed`/`Conflicted`/`Staged`.
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

/// Same shape as `src/shared/model.ts`'s `GitStatusMap`: keyed by path, relative to the worktree
/// root; a path absent from this map is clean and not ignored. `.git` itself is never a key
/// (FR-007).
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
    if x == b'R' || y == b'R' {
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

/// Parses `-z`-delimited `status --porcelain=v1` output into a `GitStatusMap`. Each entry is
/// `XY<space>path`; a renamed/copied entry additionally carries the renamed-FROM path as its own
/// extra NUL-terminated field right after -- consumed and discarded, never treated as an entry of
/// its own. Strips exactly one trailing `/` before using a path as a key (git reports an ignored
/// or untracked DIRECTORY with a trailing slash; `FileTreeNode.path` never carries one).
fn parse_status(stdout: &str) -> GitStatusMap {
    let mut map = GitStatusMap::new();
    let mut tokens = stdout.split('\0');
    while let Some(entry) = tokens.next() {
        if entry.is_empty() {
            continue;
        }
        if entry.len() < 3 {
            continue;
        }
        let code = &entry[0..2];
        let file_path = entry[3..].trim_end_matches('/');
        let is_rename = code.as_bytes()[0] == b'R' || code.as_bytes()[1] == b'R';
        if is_rename {
            tokens.next(); // renamed-from path: not a map key, `file_path` above is
        }
        if contains_git_segment(file_path) {
            continue; // FR-007: `.git` itself is never a key
        }
        map.insert(file_path.to_string(), mark_from_code(code));
    }
    map
}

/// The File explorer's shared git-status/ignore reader.
pub async fn read_git_status(worktree_path: &Path) -> Option<GitStatusMap> {
    let result = git_raw(worktree_path, STATUS_GIT_ARGS, Some(STATUS_TIMEOUT)).await;
    if result.code != 0 {
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
