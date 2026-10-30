// `--porcelain=v2` gives branch and ahead/behind in one call. A partially staged path becomes
// a Staged and a Changes row; `--no-renames` reports a rename as delete plus add.
// `--no-optional-locks` avoids blocking on an agent-held lock; `-z` keeps quoted paths intact.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::changes_parse::{folder_for, parse_porcelain_v2, GitChangesGroup, ParsedEntry};
use super::changes_score::{parse_numstat_map, score_untracked_file};
use super::git::{git, git_raw, git_raw_with_stdin, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;
use super::status::GitStatusMark;

// `--untracked-files=all` lists each file in a new directory, since this panel is a flat list.
const CHANGES_STATUS_GIT_ARGS: &[&str] = &[
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--ignore-submodules=all",
];

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);
/// The overall budget for one `read_changes_status` call; in-flight work is dropped past it.
const OVERALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Matches `status.rs`'s own cap.
const STATUS_MAX_BUFFER_BYTES: usize = 32 * 1024 * 1024;
/// Matches `diff_stat.rs`'s own cap.
const MAX_FILES: usize = 200;

/// One path's display state. `folder` is `''` for a top-level entry. `partial` means its counts were not computed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesFileEntry {
    pub path: String,
    pub folder: String,
    pub mark: GitStatusMark,
    pub additions: i64,
    pub deletions: i64,
    pub partial: bool,
}

/// The `# branch.ab` counts. Absent when no upstream exists.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: i64,
    pub behind: i64,
}

/// The panel's branch line. `base_branch` comes from the caller, not from git status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesHeader {
    pub branch: String,
    pub base_branch: String,
    pub ahead_behind: Option<AheadBehind>,
}

/// One of the four panel groups. Each list is sorted by path.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesGroups {
    pub conflicts: Vec<GitChangesFileEntry>,
    pub staged: Vec<GitChangesFileEntry>,
    pub changes: Vec<GitChangesFileEntry>,
    pub untracked: Vec<GitChangesFileEntry>,
}

/// The panel's whole state, returned in one call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesSnapshot {
    pub header: GitChangesHeader,
    pub groups: GitChangesGroups,
}

/// Scores each row's counts and sorts each group by path. Runs two numstat calls concurrently.
/// Past `MAX_FILES` rows, the rest get `partial: true` and no score.
async fn build_groups(worktree_path: &Path, entries: Vec<ParsedEntry>) -> GitChangesGroups {
    let mut groups = GitChangesGroups::default();
    if entries.is_empty() {
        return groups;
    }

    let (unstaged_result, staged_result) = tokio::join!(
        git_raw(
            worktree_path,
            &[
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "--no-optional-locks",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                "--numstat",
                "-z"
            ],
            Some(DIFF_TIMEOUT)
        ),
        git_raw(
            worktree_path,
            &[
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "--no-optional-locks",
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                "--numstat",
                "-z"
            ],
            Some(DIFF_TIMEOUT)
        ),
    );
    let unstaged_map = if unstaged_result.code == 0 {
        parse_numstat_map(&unstaged_result.stdout)
    } else {
        HashMap::new()
    };
    let staged_map = if staged_result.code == 0 {
        parse_numstat_map(&staged_result.stdout)
    } else {
        HashMap::new()
    };

    let mut files_counted: usize = 0;
    for parsed in entries {
        let folder = folder_for(&parsed.path);
        for (group, mark) in parsed.groups.iter() {
            let (additions, deletions, partial) = if files_counted >= MAX_FILES {
                (0, 0, true)
            } else {
                files_counted += 1;
                match group {
                    GitChangesGroup::Untracked => {
                        score_untracked_file(worktree_path, &parsed.path).await
                    }
                    GitChangesGroup::Staged => staged_map
                        .get(&parsed.path)
                        .map(|&(a, d)| (a, d, false))
                        .unwrap_or((0, 0, false)),
                    GitChangesGroup::Conflicts | GitChangesGroup::Changes => unstaged_map
                        .get(&parsed.path)
                        .map(|&(a, d)| (a, d, false))
                        .unwrap_or((0, 0, false)),
                }
            };
            let entry = GitChangesFileEntry {
                path: parsed.path.clone(),
                folder: folder.clone(),
                mark,
                additions,
                deletions,
                partial,
            };
            match group {
                GitChangesGroup::Conflicts => groups.conflicts.push(entry),
                GitChangesGroup::Staged => groups.staged.push(entry),
                GitChangesGroup::Changes => groups.changes.push(entry),
                GitChangesGroup::Untracked => groups.untracked.push(entry),
            }
        }
    }
    for list in [
        &mut groups.conflicts,
        &mut groups.staged,
        &mut groups.changes,
        &mut groups.untracked,
    ] {
        list.sort_by(|a, b| a.path.cmp(&b.path));
    }
    groups
}

async fn compute_changes_status(
    worktree_path: &Path,
    base_branch: &str,
) -> Option<GitChangesSnapshot> {
    let result = git_raw(worktree_path, CHANGES_STATUS_GIT_ARGS, Some(STATUS_TIMEOUT)).await;
    if result.code != 0 {
        return None;
    }
    if result.stdout.len() > STATUS_MAX_BUFFER_BYTES {
        return None;
    }
    let (branch, ahead_behind, parsed_entries) = parse_porcelain_v2(&result.stdout);
    let header = GitChangesHeader {
        branch: branch.unwrap_or_default(),
        base_branch: base_branch.to_string(),
        ahead_behind,
    };
    let groups = build_groups(worktree_path, parsed_entries).await;
    Some(GitChangesSnapshot { header, groups })
}

/// Returns `None` instead of throwing, so the panel shows "not available". Paths come from the registry, never the renderer.
pub async fn read_changes_status(
    worktree_path: &Path,
    base_branch: &str,
) -> Option<GitChangesSnapshot> {
    if tokio::fs::metadata(worktree_path).await.is_err() {
        return None;
    }
    tokio::time::timeout(
        OVERALL_TIMEOUT,
        compute_changes_status(worktree_path, base_branch),
    )
    .await
    .unwrap_or_default()
}

/// `git add --`. `validate_pathspec` checks every path, since callers are not trusted alone.
pub async fn stage_files(worktree_path: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        validate_pathspec(worktree_path, path)?;
    }
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "add",
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    git(worktree_path, &args).await?;
    Ok(())
}

/// `git restore --staged --`. Never `--worktree`, which would discard edits.
pub async fn unstage_files(worktree_path: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        validate_pathspec(worktree_path, path)?;
    }
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "restore",
        "--staged",
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    git(worktree_path, &args).await?;
    Ok(())
}

/// `git commit -F -` reads the message from stdin, avoiding argv length limits. Author identity comes from git config.
pub async fn commit(worktree_path: &Path, message: &str) -> Result<(), GitError> {
    let args = [
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "commit",
        "-F",
        "-",
    ];
    // No timeout: killing a commit hook mid-run can leave the repo inconsistent (#464).
    let result = git_raw_with_stdin(worktree_path, &args, message.as_bytes(), None).await;
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
    Ok(())
}
