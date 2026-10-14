// `diffStat` for the Session worktree, part of session worktree and lifecycle (lane R2, issue
// #785). Pre-declared so lane R2 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// Port of `src/main/git/diffStat.ts`: committed and uncommitted edits to tracked files since the
// merge-base with the Session's Base branch, plus new untracked files. Never writes: no `git
// add`, no index change. Returns `None` on any failure (missing worktree, missing Base branch,
// git failure, or the overall timeout) so the IPC handler never throws this past itself.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::git::git_raw;

const MAX_FILES: i64 = 200;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);
/// Only the first slice of a file is checked for a NUL byte (git's own binary heuristic);
/// mirrors `diffStat.ts`'s own `BINARY_SNIFF_BYTES`.
const BINARY_SNIFF_BYTES: usize = 8000;

/// Same wire shape as `src/shared/model.ts`'s `DiffStat` (`sessions.diffStat`'s return value,
/// also `SessionReadout.changes`). Named differently from `git::worktree_delete::DeleteCheck`
/// (a different channel's own return shape) even though both are per-Session git summaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStatResult {
    pub files: i64,
    pub additions: i64,
    pub deletions: i64,
    pub partial: bool,
}

/// Port of `diffStat.ts`'s own `isBinary`: true the moment a NUL byte appears in the first
/// `BINARY_SNIFF_BYTES` bytes.
fn is_binary(buf: &[u8]) -> bool {
    let len = buf.len().min(BINARY_SNIFF_BYTES);
    buf[..len].contains(&0)
}

/// Port of `diffStat.ts`'s own `countLines`: counts lines the way a brand-new file's `git diff
/// --numstat` would -- a trailing newline does not add an extra empty line, but trailing content
/// without one still counts as a line.
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

    // Plumbing, not porcelain `git diff`: `diff-index` never refreshes or writes the index, so a
    // concurrent `git add`/`git commit` in the same worktree cannot race it on `index.lock`.
    // `--no-ext-diff --no-textconv` stop a diff driver from git config running arbitrary commands.
    let numstat_result = git_raw(
        worktree_path,
        &[
            "diff-index",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            &merge_base,
        ],
        None,
    )
    .await;
    if numstat_result.code != 0 {
        return None;
    }

    // `-z` NUL-delimits entries with no C-style quoting, so non-ASCII/special-character paths
    // (e.g. `café.txt`, which git would otherwise print as a quoted `"caf\303\251.txt"`) and
    // paths with real leading/trailing spaces survive intact.
    let untracked_result = git_raw(
        worktree_path,
        &["ls-files", "-z", "--others", "--exclude-standard"],
        None,
    )
    .await;
    if untracked_result.code != 0 {
        return None;
    }

    let mut files: i64 = 0;
    let mut additions: i64 = 0;
    let mut deletions: i64 = 0;
    let mut partial = false;

    for line in numstat_result.stdout.split('\n') {
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
            let absolute_path = worktree_path.join(relative_path);
            let metadata = match tokio::fs::metadata(&absolute_path).await {
                Ok(metadata) => metadata,
                // Vanished between `ls-files` and `stat`; already counted, 0 additions.
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                partial = true;
                continue;
            }
            let bytes = match tokio::fs::read(&absolute_path).await {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if is_binary(&bytes) {
                continue; // Binary files count as a file with 0 lines.
            }
            additions += count_lines(&String::from_utf8_lossy(&bytes));
        }
    }

    Some(DiffStatResult {
        files,
        additions,
        deletions,
        partial,
    })
}

/// `sessions.diffStat(id)` (contracts/ipc.md): `worktree_path`/`base_branch` come from the
/// registry, never the renderer (constitution V). `None` when the worktree is missing, the Base
/// branch no longer exists, git fails, or the 3 s overall budget runs out before completion; the
/// in-flight git/fs work is dropped, never left running, past that budget.
pub async fn diff_stat(worktree_path: &Path, base_branch: &str) -> Option<DiffStatResult> {
    if tokio::fs::metadata(worktree_path).await.is_err() {
        return None;
    }
    tokio::time::timeout(TIMEOUT, compute_diff_stat(worktree_path, base_branch))
        .await
        .unwrap_or_default()
}
