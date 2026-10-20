// Git changes panel backend (spec 018 slice 1, issue #464): a `git status --porcelain=v2 -z
// --branch` reader, used instead of `status.rs`'s existing `--porcelain=v1` reader because v2's
// own header lines (`# branch.head`, `# branch.upstream`, `# branch.ab`) carry branch name,
// upstream, and ahead/behind counts in the SAME call this panel needs for its own header row
// (research.md decision 1) -- a second `git rev-list --left-right --count` call is never needed
// purely for that header. `GitStatusMark` is reused UNCHANGED from `status.rs` (research.md
// decision 2); only the porcelain-v2 parser itself is new -- v2's per-entry shape (`1 XY sub mH
// mI mW hH hI path` for an ordinary change, `2 ...` for a rename/copy with a rename score plus a
// second NUL-terminated origPath, `u XY sub m1 m2 m3 mW h1 h2 h3 path` for an unmerged/conflicted
// entry, `? path` for untracked, and `.` rather than v1's space for an unchanged XY column)
// differs enough that `status.rs::parse_status` is not reused as-is, following its established
// NUL-delimited, `get`-based-slicing pattern (never indexed directly) rather than its literal
// function body.
//
// Grouping (FR-002, amended by gate round 1 item 5 / issue #464, Skippy's decision on behalf of
// Stuart): computed directly from each entry's own XY pair, not from the collapsed
// `GitStatusMark` alone. A record whose Y column is `.` groups as Staged only; a record whose X
// column is `.` groups as Changes/Untracked only -- both exactly as before. A record with BOTH
// columns non-`.` (partially staged -- `MM`/`AM`/`RM` and friends) now produces TWO separate
// rows for the SAME path, like VS Code: one in Staged (scored against the `--cached` numstat
// map, mark driven by the X column alone: `D`->Deleted, `A`->Added, else `Staged`) and one in
// Changes (scored against the plain numstat map, mark driven by the Y column alone: `D`->
// Deleted, else `Modified` -- Y is only ever `M`/`D`/`T` for an ordinary entry per git's own
// porcelain v2 format, never `A`/`R`). This applies uniformly to ordinary (`1`) AND rename/copy
// (`2`) records alike -- a partially-staged rename's own Staged-half mark is therefore `Staged`
// (X is `R`, never `D`/`A`), not `Renamed`; the `Renamed` mark survives only for a rename with
// nothing further pending in the worktree (Y == `.`, still a single Staged-only row, unchanged).
// An unmerged (`u`) entry is always exactly one Conflicts row regardless of its own XY (FR-002,
// unchanged). See `ParsedGroups`/`group_marks_for_xy` for the implementation and
// `specs/018-git-changes-panel/spec.md`'s own FR-002 for the amended requirement text.
//
// Per-file additions/deletions (FR-019) follow `diff_stat.rs`'s own `MAX_FILES`/partial
// convention (the exact constant values are re-declared here rather than imported: both are
// private `const`s in their own file, and this module's per-FILE partial flag is a different
// shape from `diff_stat.rs`'s own whole-result `partial` flag). Staged entries read from one
// `git diff --cached --numstat` call; every other entry reads from one `git diff --numstat`
// call; an untracked entry has no index/HEAD side to diff against at all, so its additions are
// counted directly from its own content (reusing `diff_stat.rs`'s `is_binary`/`count_lines`
// approach, re-declared locally for the same reason). `--no-renames` is passed to both numstat
// calls so a rename always reports as a plain delete (old path) plus add (new path) rather than
// the `old => new` arrow notation -- this panel only ever needs the counts for the path status
// parsing already resolved, not a second rename-aware path-matching pass. `MAX_FILES` counts
// each produced ROW, not each parsed status line (gate round 1 item 5): a partially-staged file
// producing two rows counts as 2 toward the cap.
//
// Hardened invocation flags (gate round 1 items 9/10, issue #464): every `git` call this module
// makes gets `--literal-pathspecs` (every pathspec argument matched literally, never
// glob-interpreted) and `-c core.fsmonitor=false` as global options before the subcommand,
// mirroring `status.rs`'s own `STATUS_GIT_ARGS` convention. Every numstat call additionally gets
// `--no-color`, `--no-optional-locks` (never block on a concurrent agent-held lock; read a
// possibly-slightly-stale index instead of hanging, same reasoning as `status.rs`'s own
// read), and `-z` (NUL-delimited records, so a quoted/non-ASCII path is never silently
// corrupted by `.trim()`ing a C-quoted string -- see `changes_score::parse_numstat_map`'s own

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::changes_parse::{folder_for, parse_porcelain_v2, GitChangesGroup, ParsedEntry};
use super::changes_score::{parse_numstat_map, score_untracked_file};
use super::git::{git, git_raw, git_raw_with_stdin, GitError, GitErrorCode};
use super::pathspec::validate_pathspec;
use super::status::GitStatusMark;

// `--untracked-files=all` (unlike `status.rs`'s own default/"normal" mode, left as-is for the
// File explorer's own TREE, where a collapsed untracked directory is fine since expanding it
// lists its own files separately): this panel is a FLAT list (no tree), so an entire new,
// untracked directory must still explode into one row per individual file inside it, or none of
// those files could ever be staged/diffed individually (FR-005, FR-006).
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
/// The overall budget for one `read_changes_status` call (status read + two numstat reads +
/// every untracked file's own content read) -- mirrors `diff_stat.rs`'s own `TIMEOUT` wrapping
/// the whole of `compute_diff_stat`: the in-flight work is dropped, never left running, past
/// this budget.
const OVERALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Mirrors `status.rs`'s own `STATUS_MAX_BUFFER_BYTES` (FR-018): re-declared rather than
/// imported since that constant is a private `const` in its own file.
const STATUS_MAX_BUFFER_BYTES: usize = 32 * 1024 * 1024;
/// Mirrors `diff_stat.rs`'s own `MAX_FILES` (FR-019): re-declared for the same reason.
const MAX_FILES: usize = 200;

/// data-model.md "Git changes file row": one path's display state for this panel. `folder` is
/// the path's own POSIX-relative containing directory (`''` for a top-level entry), matching
/// `FileTreeNode.path`'s own convention (FR-005). `partial` (FR-019): this file's own
/// additions/deletions were not fully computed -- either the `MAX_FILES` cap was already reached
/// before this file was counted, or (for an untracked file) its content exceeds `MAX_FILE_BYTES`
/// -- the row itself still appears and is still fully operable (stage/unstage/diff), only its
/// own badge shows "(partial)" (`sessionDisplay.tsx`'s existing wording).
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

/// data-model.md "Panel count"/header figure: `git status --porcelain=v2 -z --branch`'s own
/// `# branch.ab +<ahead> -<behind>` header line, present only when an upstream exists and the
/// commit it points at is known locally (FR-014: entirely omitted otherwise).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: i64,
    pub behind: i64,
}

/// data-model.md "Git changes header": the panel's own branch-line data (FR-014). `base_branch`
/// is NOT parsed from git status at all -- it is the Session's own already-stored
/// `Registry::Session::base_branch` (`SessionDetailsCard.tsx`'s own "from {base}" muted text),
/// passed in by the caller (`ipc::git_changes`) exactly as `diff_stat::diff_stat` already takes
/// it, never re-derived here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesHeader {
    pub branch: String,
    pub base_branch: String,
    pub ahead_behind: Option<AheadBehind>,
}

/// data-model.md "Git changes group" x4: every non-ignored status entry sorted into exactly one
/// of these four lists (FR-002), each already numstat-scored and alphabetically ordered by path.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesGroups {
    pub conflicts: Vec<GitChangesFileEntry>,
    pub staged: Vec<GitChangesFileEntry>,
    pub changes: Vec<GitChangesFileEntry>,
    pub untracked: Vec<GitChangesFileEntry>,
}

/// `gitChanges.list`'s own return shape (contracts/ipc.md): the panel's whole state in one call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesSnapshot {
    pub header: GitChangesHeader,
    pub groups: GitChangesGroups,
}

/// FR-019: scores every parsed entry's additions/deletions and sorts each of the four groups by
/// path. Two `git diff --numstat` calls (unstaged, cached) run once each, concurrently, covering
/// every tracked entry regardless of group; an untracked entry is scored from its own content
/// instead (see `score_untracked_file`). The `MAX_FILES` cap applies across every ROW produced
/// (gate round 1 item 5: a partially-staged entry producing two rows counts as 2) -- once
/// reached, every further row still gets its own entry, just with `partial: true` and no attempt
/// to compute its score. Both numstat calls are hardened (gate round 1 items 9/10, issue #464):
/// `--literal-pathspecs`/`-c core.fsmonitor=false` as global options, `--no-color`/
/// `--no-optional-locks` alongside the already-present `--no-ext-diff --no-textconv`, and `-z`
/// so `parse_numstat_map` never has to `.trim()` a C-quoted path.
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

/// `gitChanges.list(sessionId)` (contracts/ipc.md): `worktree_path`/`base_branch` come from the
/// registry, never the renderer (constitution V). `None` when the worktree is missing, not a git
/// repository, a git call fails, the status read exceeds `STATUS_MAX_BUFFER_BYTES` (FR-018), or
/// the overall budget runs out -- never thrown, mirrors `diff_stat.rs`'s own never-throw
/// convention; the panel shows a not-available state rather than hanging or crashing (SC-006).
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

/// `git add --`, every path a literal post-`--` argv entry (FR-007) -- `paths` must already come
/// only from the current status map's own keys; `validate_pathspec` is the backstop that never
/// trusts that alone (constitution V). A no-op for an empty `paths`.
pub async fn stage_files(worktree_path: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        validate_pathspec(worktree_path, path)?;
    }
    let mut args: Vec<&str> = vec!["--literal-pathspecs", "-c", "core.fsmonitor=false", "add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(worktree_path, &args).await?;
    Ok(())
}

/// `git restore --staged --`, the same path-sourcing rule and `validate_pathspec` backstop as
/// `stage_files` (FR-007, research.md decision 3: the dedicated `restore` verb, never
/// `checkout`, and never `--worktree`, which is slice 3's own discard verb).
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

/// `git commit -F -`, the composed message piped on stdin -- never `-m` (FR-011, research.md
/// decision 4: no argv quoting/length-limit footgun for a multi-line subject+body message).
/// Commit author identity comes solely from the worktree's own already-configured `git config
/// user.name`/`user.email` (FR-025); an unconfigured identity surfaces here as git's own plain
/// `GitFailed` error, exactly like any other git failure (FR-013), never a Refract-side override.
pub async fn commit(worktree_path: &Path, message: &str) -> Result<(), GitError> {
    let args = [
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "commit",
        "-F",
        "-",
    ];
    // Gate round 1 item 4 (#464): no timeout -- a commit hook (pre-commit, commit-msg) can
    // legitimately run long, and killing it mid-hook is unsafe (an interrupted hook can leave
    // repo state inconsistent). The renderer's own `committing` boolean is the only
    // double-submit guard going forward, not a server-side timeout.
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
