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
// Grouping (FR-002) is computed directly from each entry's own XY pair, not from the collapsed
// `GitStatusMark` alone: an entry with a non-`.` Y column (a further, unstaged worktree edit on
// top of whatever the X column already represents) always groups as Changes; otherwise, a
// non-`.` X column groups as Staged. This stays correct for every record type, including a
// staged add/rename with an additional unstaged edit on top (`AM`-equivalent in v1 terms) --
// deriving the group from the already-collapsed mark instead (which lets a Delete/Add/Rename
// precedence check win over the Y-column check, matching `status.rs`'s own single-badge
// precedence) would wrongly file such a file as Staged even though it still has pending unstaged
// work. An unmerged (`u`) entry is always Conflicts regardless of its own XY (FR-002).
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
// parsing already resolved, not a second rename-aware path-matching pass.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::fs::paths::contains_git_segment;

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
const COMMIT_TIMEOUT: Duration = Duration::from_secs(10);
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

/// One of the four fixed buckets every non-ignored status entry sorts into exactly once
/// (FR-002, data-model.md "Git changes group"). Internal to this module's own parsing/grouping
/// step -- never serialised on its own; group membership reaches the wire purely as which list
/// (`GitChangesGroups`'s own fields) a `GitChangesFileEntry` appears in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitChangesGroup {
    Conflicts,
    Staged,
    Changes,
    Untracked,
}

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

/// One already-classified status entry, before its own additions/deletions are scored --
/// `build_groups` fills those in with a second pass (the two numstat reads it needs run once
/// each for every entry, not once per entry).
struct ParsedEntry {
    path: String,
    mark: GitStatusMark,
    group: GitChangesGroup,
}

/// Mark/group for an ordinary ("1") entry: never conflict or rename (those are their own record
/// types, `u`/`2`), so the only remaining precedence is delete, then add, then the generic
/// modified-or-staged split on the Y column -- the same shape `status.rs::mark_from_code` uses
/// for its own non-conflict/non-rename branch, adapted to v2's `.`-for-unchanged convention.
fn mark_for_ordinary(xy: &[u8]) -> GitStatusMark {
    let (x, y) = (xy[0], xy[1]);
    if x == b'D' || y == b'D' {
        GitStatusMark::Deleted
    } else if x == b'A' {
        GitStatusMark::Added
    } else if y != b'.' {
        GitStatusMark::Modified
    } else {
        GitStatusMark::Staged
    }
}

/// FR-002's own grouping rule, independent of the (lossy, precedence-collapsed) `GitStatusMark`
/// value: a non-`.` Y column means there is still a pending UNSTAGED edit on top of whatever the
/// X column represents, which always groups as Changes regardless of record type; otherwise a
/// non-`.` X column groups as Staged. Applies uniformly to ordinary and rename/copy entries
/// alike (a rename is always carried by the index, per git's own porcelain v2 format -- a
/// worktree-only move is reported as a plain delete+untracked-add pair, never a `2` record).
fn group_for_xy(xy: &[u8]) -> GitChangesGroup {
    let (x, y) = (xy[0], xy[1]);
    if y != b'.' {
        GitChangesGroup::Changes
    } else if x != b'.' {
        GitChangesGroup::Staged
    } else {
        // Should not occur for a listed entry (both columns unchanged); Changes is the safer
        // default -- it still shows the row rather than silently dropping it.
        GitChangesGroup::Changes
    }
}

fn parse_ahead_behind(value: &str) -> Option<AheadBehind> {
    let mut parts = value.split_whitespace();
    let ahead_raw = parts.next()?;
    let behind_raw = parts.next()?;
    let ahead = ahead_raw.strip_prefix('+')?.parse::<i64>().ok()?;
    let behind = behind_raw.strip_prefix('-')?.parse::<i64>().ok()?;
    Some(AheadBehind { ahead, behind })
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`: 7 space-separated fields before `path`, which
/// is the remainder (never re-split -- a path itself may contain spaces).
fn parse_ordinary_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("1 ")?;
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    for _ in 0..6 {
        parts.next()?; // sub, mH, mI, mW, hH, hI
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    let xy_bytes = xy.as_bytes();
    Some(ParsedEntry {
        path: path.to_string(),
        mark: mark_for_ordinary(xy_bytes),
        group: group_for_xy(xy_bytes),
    })
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`, with `<origPath>` as its own
/// SEPARATE NUL-terminated token right after (consumed by the caller's own `tokens.next()`,
/// mirroring `status.rs::parse_status`'s identical handling of a v1 rename's extra field) --
/// always `Renamed`, since record type `2` itself is git's own signal for a rename or copy.
fn parse_rename_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("2 ")?;
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    for _ in 0..7 {
        parts.next()?; // sub, mH, mI, mW, hH, hI, Xscore
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    Some(ParsedEntry {
        path: path.to_string(),
        mark: GitStatusMark::Renamed,
        group: group_for_xy(xy.as_bytes()),
    })
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: always Conflicts/Conflicted
/// regardless of its own XY (FR-002: "a conflicted entry always sorted into Conflicts
/// regardless of any other mark it might otherwise also carry").
fn parse_unmerged_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("u ")?;
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next()?;
    for _ in 0..8 {
        parts.next()?; // sub, m1, m2, m3, mW, h1, h2, h3
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    Some(ParsedEntry {
        path: path.to_string(),
        mark: GitStatusMark::Conflicted,
        group: GitChangesGroup::Conflicts,
    })
}

/// Parses `-z`-delimited `status --porcelain=v2 --branch` output: header lines into the branch
/// name and ahead/behind pair, and `1`/`2`/`u`/`?` entry lines into `ParsedEntry`s. `!` (ignored)
/// lines are skipped outright (FR-002 "every non-ignored status entry") -- none are expected
/// since `--ignored` is never passed, but a line in that shape is still defensively dropped
/// rather than misparsed. Every slice is `get`/`strip_prefix`-based (never indexed directly,
/// matching `status.rs::parse_status`'s own discipline): a malformed or truncated entry is
/// skipped, never a panic.
fn parse_porcelain_v2(stdout: &str) -> (Option<String>, Option<AheadBehind>, Vec<ParsedEntry>) {
    let mut branch: Option<String> = None;
    let mut ahead_behind: Option<AheadBehind> = None;
    let mut entries = Vec::new();

    let mut tokens = stdout.split('\0');
    while let Some(entry) = tokens.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            if let Some(value) = header.strip_prefix("branch.head ") {
                if value != "(detached)" {
                    branch = Some(value.to_string());
                }
            } else if let Some(value) = header.strip_prefix("branch.ab ") {
                ahead_behind = parse_ahead_behind(value);
            }
            continue;
        }
        match entry.get(0..1) {
            Some("1") => {
                if let Some(parsed) = parse_ordinary_entry(entry) {
                    entries.push(parsed);
                }
            }
            Some("2") => {
                if let Some(parsed) = parse_rename_entry(entry) {
                    entries.push(parsed);
                }
                tokens.next(); // origPath: never a row of its own, discarded
            }
            Some("u") => {
                if let Some(parsed) = parse_unmerged_entry(entry) {
                    entries.push(parsed);
                }
            }
            Some("?") => {
                if let Some(path) = entry.get(2..) {
                    if !contains_git_segment(path) {
                        entries.push(ParsedEntry {
                            path: path.to_string(),
                            mark: GitStatusMark::Untracked,
                            group: GitChangesGroup::Untracked,
                        });
                    }
                }
            }
            _ => {} // "!" (ignored, not requested) or malformed -- skipped
        }
    }
    (branch, ahead_behind, entries)
}

fn folder_for(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => String::new(),
    }
}

/// FR-019: scores every parsed entry's additions/deletions and sorts each of the four groups by
/// path. Two `git diff --numstat` calls (unstaged, cached) run once each, concurrently, covering
/// every tracked entry regardless of group; an untracked entry is scored from its own content
/// instead (see `score_untracked_file`). The `MAX_FILES` cap applies across every group combined
/// (matching `diff_stat.rs`'s own single running counter) -- once reached, every further entry
/// still gets its own row, just with `partial: true` and no attempt to compute its score.
async fn build_groups(worktree_path: &Path, entries: Vec<ParsedEntry>) -> GitChangesGroups {
    let mut groups = GitChangesGroups::default();
    if entries.is_empty() {
        return groups;
    }

    let (unstaged_result, staged_result) = tokio::join!(
        git_raw(
            worktree_path,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--numstat"
            ],
            Some(DIFF_TIMEOUT)
        ),
        git_raw(
            worktree_path,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--numstat"
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
        let (additions, deletions, partial) = if files_counted >= MAX_FILES {
            (0, 0, true)
        } else {
            files_counted += 1;
            match parsed.group {
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
            path: parsed.path,
            folder,
            mark: parsed.mark,
            additions,
            deletions,
            partial,
        };
        match parsed.group {
            GitChangesGroup::Conflicts => groups.conflicts.push(entry),
            GitChangesGroup::Staged => groups.staged.push(entry),
            GitChangesGroup::Changes => groups.changes.push(entry),
            GitChangesGroup::Untracked => groups.untracked.push(entry),
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
    let mut args: Vec<&str> = vec!["add", "--"];
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
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
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
    let args = ["commit", "-F", "-"];
    let result = git_raw_with_stdin(
        worktree_path,
        &args,
        message.as_bytes(),
        Some(COMMIT_TIMEOUT),
    )
    .await;
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
