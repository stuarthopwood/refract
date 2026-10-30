//! Session worktree diff stat; read-only and `None` on any failure.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::changes_score::score_untracked_file as score_untracked_entry;
use super::git::git_raw;

const MAX_FILES: i64 = 200;
#[cfg(test)]
const MAX_FILE_BYTES: u64 = 1024 * 1024;
// Tests get a longer budget: a parallel `cargo test` run on Windows can push the git spawns past 3 s (#1445).
const TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(30)
} else {
    Duration::from_secs(3)
};
/// Only the first slice of a file is checked for a NUL byte (git's binary heuristic).
#[cfg(test)]
const BINARY_SNIFF_BYTES: usize = 8000;

/// Wire shape of `DiffStat` for `sessions.diffStat`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStatResult {
    pub files: i64,
    pub additions: i64,
    pub deletions: i64,
    pub partial: bool,
}

/// True if a NUL byte appears in the first `BINARY_SNIFF_BYTES` bytes.
#[cfg(test)]
fn is_binary(buf: &[u8]) -> bool {
    let len = buf.len().min(BINARY_SNIFF_BYTES);
    buf[..len].contains(&0)
}

/// Counts lines like `git diff --numstat` on a new file (trailing newline adds none).
#[cfg(test)]
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

/// Parses `git diff-index --numstat` output, stopping at `MAX_FILES` (`partial = true`).
fn count_numstat_lines(stdout: &str) -> (i64, i64, i64, bool) {
    let mut files: i64 = 0;
    let mut additions: i64 = 0;
    let mut deletions: i64 = 0;
    let mut partial = false;

    for line in stdout.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        if files >= MAX_FILES {
            partial = true;
            break;
        }
        let mut columns = line.splitn(3, '\t');
        let add_raw = columns.next().unwrap_or("");
        let del_raw = columns.next().unwrap_or("");
        files += 1;
        if add_raw != "-" {
            additions += add_raw.parse::<i64>().unwrap_or(0);
        }
        if del_raw != "-" {
            deletions += del_raw.parse::<i64>().unwrap_or(0);
        }
    }

    (files, additions, deletions, partial)
}

/// Scores one untracked file: oversized is `partial`, unreadable or binary is 0 additions.
#[cfg(test)]
fn score_untracked_file(size: u64, content: Option<&[u8]>) -> (i64, bool) {
    if size > MAX_FILE_BYTES {
        return (0, true);
    }
    let Some(bytes) = content else {
        return (0, false);
    };
    if is_binary(bytes) {
        return (0, false);
    }
    (count_lines(&String::from_utf8_lossy(bytes)), false)
}

async fn compute_diff_stat(worktree_path: &Path, base_branch: &str) -> Option<DiffStatResult> {
    let merge_base_result = git_raw(
        worktree_path,
        &["merge-base", "--end-of-options", "HEAD", base_branch],
        None,
    )
    .await;
    if merge_base_result.code != 0 {
        return None;
    }
    let merge_base = merge_base_result.stdout.trim().to_string();
    if merge_base.is_empty() {
        return None;
    }

    // `diff-index` plumbing never writes the index (no `index.lock` race); the --no-* flags stop
    // config diff drivers running commands. Independent of the untracked listing, so run both
    // concurrently.
    let diff_index_args = [
        "diff-index",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        merge_base.as_str(),
    ];
    let untracked_args = ["ls-files", "-z", "--others", "--exclude-standard"];
    let (numstat_result, untracked_result) = tokio::join!(
        git_raw(worktree_path, &diff_index_args, None),
        git_raw(worktree_path, &untracked_args, None)
    );
    if numstat_result.code != 0 {
        return None;
    }
    if untracked_result.code != 0 {
        return None;
    }

    let (mut files, mut additions, deletions, mut partial) =
        count_numstat_lines(&numstat_result.stdout);

    if !partial {
        for relative_path in untracked_result
            .stdout
            .split('\0')
            .filter(|entry| !entry.is_empty())
        {
            if files >= MAX_FILES {
                partial = true;
                break;
            }
            files += 1;
            // Never read through a symlink (#1115); escape/missing/unreadable score 0.
            let (file_additions, _deletions, file_partial) =
                score_untracked_entry(worktree_path, relative_path).await;
            additions += file_additions;
            partial = partial || file_partial;
        }
    }

    Some(DiffStatResult {
        files,
        additions,
        deletions,
        partial,
    })
}

/// Diff stat for a Session worktree; paths come from the registry, never the renderer.
/// `None` on any failure or after the 3 s budget (in-flight work is dropped).
pub async fn diff_stat(worktree_path: &Path, base_branch: &str) -> Option<DiffStatResult> {
    if tokio::fs::metadata(worktree_path).await.is_err() {
        return None;
    }
    tokio::time::timeout(TIMEOUT, compute_diff_stat(worktree_path, base_branch))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::git::git;
    use super::*;

    #[test]
    fn count_lines_empty_string_is_zero_lines() {
        assert_eq!(count_lines(""), 0);
    }

    #[test]
    fn count_lines_trailing_newline_does_not_add_an_extra_empty_line() {
        assert_eq!(count_lines("one\ntwo\n"), 2);
    }

    #[test]
    fn count_lines_trailing_content_with_no_final_newline_still_counts_as_a_line() {
        assert_eq!(count_lines("one\ntwo"), 2);
    }

    #[test]
    fn count_lines_normalizes_crlf_and_lone_cr_to_lf_first() {
        assert_eq!(count_lines("one\r\ntwo\rthree\n"), 3);
    }

    #[test]
    fn is_binary_true_when_a_nul_byte_appears_in_the_sniffed_prefix() {
        assert!(is_binary(b"abc\0def"));
    }

    #[test]
    fn is_binary_false_for_plain_text() {
        assert!(!is_binary(b"abc def\nghi\n"));
    }

    #[test]
    fn is_binary_only_sniffs_the_first_binary_sniff_bytes() {
        let mut buf = vec![b'a'; BINARY_SNIFF_BYTES];
        buf.push(0); // NUL just past the sniffed window
        assert!(!is_binary(&buf));
    }

    #[test]
    fn count_numstat_lines_sums_additions_and_deletions_skipping_dash_sentinels() {
        let stdout = "3\t1\ta.txt\n-\t-\tbinary.bin\n0\t5\tb.txt\n";
        let (files, additions, deletions, partial) = count_numstat_lines(stdout);
        assert_eq!(files, 3);
        assert_eq!(additions, 3);
        assert_eq!(deletions, 6);
        assert!(!partial);
    }

    #[test]
    fn count_numstat_lines_max_files_cap_sets_partial_and_stops_counting() {
        let mut stdout = String::new();
        for i in 0..(MAX_FILES + 10) {
            stdout.push_str(&format!("1\t0\tfile-{i}.txt\n"));
        }
        let (files, _additions, _deletions, partial) = count_numstat_lines(&stdout);
        assert_eq!(files, MAX_FILES);
        assert!(partial);
    }

    #[test]
    fn score_untracked_file_within_cap_counts_lines() {
        let (additions, partial) = score_untracked_file(12, Some(b"one\ntwo\n"));
        assert_eq!(additions, 2);
        assert!(!partial);
    }

    #[test]
    fn score_untracked_file_over_max_file_bytes_is_partial_with_zero_additions() {
        let (additions, partial) = score_untracked_file(MAX_FILE_BYTES + 1, Some(b"one\ntwo\n"));
        assert_eq!(additions, 0);
        assert!(partial);
    }

    #[test]
    fn score_untracked_file_over_max_file_bytes_ignores_content_entirely() {
        // Real caller never reads oversized files, so the cap must depend only on `size`.
        let (additions, partial) = score_untracked_file(MAX_FILE_BYTES + 1, None);
        assert_eq!(additions, 0);
        assert!(partial);
    }

    #[test]
    fn score_untracked_file_read_failure_within_cap_is_zero_additions_not_partial() {
        let (additions, partial) = score_untracked_file(10, None);
        assert_eq!(additions, 0);
        assert!(!partial);
    }

    #[test]
    fn score_untracked_file_binary_counts_as_zero_additions_not_partial() {
        let (additions, partial) = score_untracked_file(7, Some(b"abc\0def"));
        assert_eq!(additions, 0);
        assert!(!partial);
    }

    fn fresh_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("refract-diff-stat-test-{}", uuid::Uuid::new_v4()))
    }

    async fn init_repo(dir: &Path) {
        tokio::fs::create_dir_all(dir).await.unwrap();
        git(dir, &["init", "-b", "main"]).await.unwrap();
        git(dir, &["config", "user.email", "test@example.com"])
            .await
            .unwrap();
        git(dir, &["config", "user.name", "Test"]).await.unwrap();
    }

    #[tokio::test]
    async fn diff_stat_counts_tracked_edits_and_untracked_files() {
        let dir = fresh_dir();
        init_repo(&dir).await;
        tokio::fs::write(dir.join("tracked.txt"), "line one\nline two\n")
            .await
            .unwrap();
        git(&dir, &["add", "tracked.txt"]).await.unwrap();
        git(&dir, &["commit", "-m", "initial"]).await.unwrap();

        tokio::fs::write(dir.join("tracked.txt"), "line one\nline two\nline three\n")
            .await
            .unwrap();
        tokio::fs::write(dir.join("untracked.txt"), "untracked line\n")
            .await
            .unwrap();

        let result = diff_stat(&dir, "main")
            .await
            .expect("diff_stat should succeed");
        assert_eq!(result.files, 2);
        assert_eq!(result.additions, 2);
        assert_eq!(result.deletions, 0);
        assert!(!result.partial);
    }

    #[tokio::test]
    async fn diff_stat_returns_none_when_the_worktree_path_does_not_exist() {
        let dir = fresh_dir(); // Never created on disk.
        assert!(diff_stat(&dir, "main").await.is_none());
    }

    #[tokio::test]
    async fn diff_stat_returns_none_when_the_base_branch_does_not_exist() {
        let dir = fresh_dir();
        init_repo(&dir).await;
        tokio::fs::write(dir.join("tracked.txt"), "line one\n")
            .await
            .unwrap();
        git(&dir, &["add", "tracked.txt"]).await.unwrap();
        git(&dir, &["commit", "-m", "initial"]).await.unwrap();

        assert!(diff_stat(&dir, "no-such-branch").await.is_none());
    }
}
