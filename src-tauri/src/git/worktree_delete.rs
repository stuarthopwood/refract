// Port of `src/main/git/worktrees.ts`'s issue #599 safe-delete path (folded into lane R2, #785):
// `removeSessionWorktree`. Decides purely from live git/filesystem state, idempotent (a retry
// re-reads state from scratch), never deletes anything outside `worktrees_root(repo)` nor
// anything `git worktree list` does not account for. `deleteCheck`/`deleteCheckForMissingWorktree`
// /`deleteCheckForSession` live in the sibling `worktree_delete_check.rs` (600-line cap split).
//
// Path comparisons use `worktree_validity`'s lexical `comparable_path` EXCEPT
// `is_repo_readable`/`dot_git_points_to`, which canonicalize via `canonical_comparable_path`
// (gate round 2 CI fix: GitHub Actions' Windows runners alias `%TEMP%` through an 8.3 short
// name `git rev-parse` never reports).

use std::path::{Path, PathBuf};

use crate::fs::remove_tree::{remove_tree, RemoveTreeError};

use super::git::{git, git_raw, normalize_git_path, GitError, GitErrorCode};
use super::worktree_validity::{
    canonical_comparable_path, comparable_path, is_worktree_registered,
};
use super::worktrees::{branch_exists, worktrees_root};

/// Issue #891 trimmed this to only the two reasons still reachable: both `remove_orphaned_
/// worktree_folder` and the registered path now remove a non-empty folder themselves (via
/// `fs::remove_tree`) rather than refusing on sight of its contents.
enum OrphanRefusalReason {
    IsALink,
    NotADirectory,
}

fn orphan_refusal_message(worktree_path: &Path, reason: OrphanRefusalReason) -> String {
    let wt = worktree_path.display();
    match reason {
        OrphanRefusalReason::IsALink => format!("Refract did not delete anything. {wt} is a link, not a worktree folder. Remove only the link itself (in File Explorer delete the link; do not delete its contents), then choose Delete again."),
        OrphanRefusalReason::NotADirectory => format!("Refract did not delete anything. {wt} is a file, not a worktree folder. Remove it yourself, then choose Delete again."),
    }
}

fn outside_worktrees_root_message(
    worktree_path: &Path,
    root: &Path,
    repo: &Path,
    is_root_itself: bool,
) -> String {
    let wt = normalize_git_path(&worktree_path.to_string_lossy());
    if is_root_itself {
        return format!("Refract did not delete anything. {wt} is Refract's worktree folder itself, not a single worktree. Delete the individual Session worktrees inside it instead, then choose Delete again for each.");
    }
    format!(
        "Refract did not delete anything. {wt} is outside Refract's worktree folder ({}), so Refract will never remove it. To remove this Session, move or rename that folder yourself (only if you are sure it is not your own work), or run `git worktree remove` on that path yourself in the repository at {}, then choose Delete again. If git says it has uncommitted changes or is locked, run `git worktree unlock` on that path if it is locked, then `git worktree remove --force` (this deletes any uncommitted work in that folder).",
        normalize_git_path(&root.to_string_lossy()),
        normalize_git_path(&repo.to_string_lossy())
    )
}

fn locked_worktree_message(worktree_path: &Path) -> String {
    format!("Refract did not delete anything. Git has locked the worktree {}, so Refract will not remove it. If you no longer need it, unlock it first: run `git worktree unlock` in the repository, followed by that folder's path, then choose Delete again.", worktree_path.display())
}

fn admin_entry_refusal_message(worktree_path: &Path) -> String {
    format!("Refract did not delete anything. It could not safely identify {}'s own git admin entry. Remove that folder yourself, then choose Delete again.", worktree_path.display())
}

/// Mirrors `worktrees.ts`'s own `isLockLikeError`/`wrapFsError`: a Windows sharing violation
/// (`ERROR_SHARING_VIOLATION`, 32) or access-denied (`ERROR_ACCESS_DENIED`, 5) gets dedicated
/// wording naming the worktree path; any other I/O error is wrapped generically.
fn wrap_fs_error(err: std::io::Error, worktree_path: &Path) -> GitError {
    let wt = worktree_path.display();
    match err.raw_os_error() {
        Some(32) => GitError::new(
            GitErrorCode::WorktreeFailed,
            format!("Refract could not remove {wt} because another program is using it. Close any terminal or editor open in that folder, then choose Delete again."),
        ),
        Some(5) => GitError::new(
            GitErrorCode::WorktreeFailed,
            format!("Refract could not remove {wt}: Windows denied access. Another program may be using it, or you may not have permission. Close any terminal or editor open in that folder, check its permissions, then choose Delete again."),
        ),
        _ => GitError::new(
            GitErrorCode::WorktreeFailed,
            format!("Refract could not remove {wt}: {err}"),
        ),
    }
}

/// Maps `fs::remove_tree`'s own error into the same `GitError` shape every other refusal in
/// this file uses. `RemoveTreeError::Io` names the EXACT sub-path that failed (not
/// `worktree_path` itself) -- issue #891's "if a removal later fails part-way, report exactly
/// what remains" -- so `wrap_fs_error`'s own sharing-violation/access-denied wording correctly
/// points at whatever file or folder a holder actually appeared on, not the worktree root.
fn map_remove_tree_error(err: RemoveTreeError, worktree_path: &Path) -> GitError {
    match err {
        RemoveTreeError::OutsideBoundary => GitError::new(
            GitErrorCode::WorktreeFailed,
            format!(
                "Refract did not delete anything. {} resolves outside Refract's worktree folder (likely through a link somewhere above it), so Refract will not remove it. Check what it actually points to, then choose Delete again.",
                worktree_path.display()
            ),
        ),
        RemoveTreeError::Io { path, source } => wrap_fs_error(source, &path),
    }
}

async fn lstat_optional(p: &Path) -> Result<Option<std::fs::Metadata>, GitError> {
    match tokio::fs::symlink_metadata(p).await {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(wrap_fs_error(e, p)),
    }
}

async fn git_common_dir(repo: &Path) -> Result<PathBuf, GitError> {
    let raw = git(repo, &["rev-parse", "--git-common-dir"]).await?;
    let raw = raw.trim();
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        repo.join(raw)
    };
    Ok(PathBuf::from(normalize_git_path(&abs.to_string_lossy())))
}

/// See this file's own header: resolves both sides through `canonical_comparable_path` before
/// comparing -- a relative `gitdir:` record resolved lexically against `dir` would otherwise
/// never match `expected` whenever `dir` is reached through an alias (a junction, or a Windows
/// 8.3 short name such as `RUNNER~1`, the gate round 2 CI failure this fixes).
async fn dot_git_points_to(dir: &Path, expected: &str) -> bool {
    let dot_git_path = dir.join(".git");
    let Ok(meta) = tokio::fs::symlink_metadata(&dot_git_path).await else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let Ok(content) = tokio::fs::read_to_string(&dot_git_path).await else {
        return false;
    };
    let Some(recorded_raw) = content
        .lines()
        .find_map(|l| l.strip_prefix("gitdir:"))
        .map(str::trim)
    else {
        return false;
    };
    let recorded_abs = if Path::new(recorded_raw).is_absolute() {
        PathBuf::from(recorded_raw)
    } else {
        dir.join(recorded_raw)
    };
    canonical_comparable_path(&recorded_abs).await
        == canonical_comparable_path(Path::new(expected)).await
}

/// Verifies `repo` is its own git toplevel (never an ancestor repository) and that git's own
/// `--absolute-git-dir`/`--git-common-dir` answers tie back to `repo`'s own `.git` entry, not
/// merely to each other. Canonicalizes every comparison for the same reason `dot_git_points_to`
/// above does.
pub(crate) async fn is_repo_readable(repo: &Path) -> bool {
    let toplevel_result = git_raw(repo, &["rev-parse", "--show-toplevel"], None).await;
    if toplevel_result.code != 0 {
        return false;
    }
    let toplevel = toplevel_result.stdout.trim();
    if toplevel.is_empty()
        || canonical_comparable_path(Path::new(toplevel)).await
            != canonical_comparable_path(repo).await
    {
        return false;
    }

    let git_dir_result = git_raw(repo, &["rev-parse", "--absolute-git-dir"], None).await;
    if git_dir_result.code != 0 {
        return false;
    }
    let git_dir_raw = git_dir_result.stdout.trim().to_string();
    if git_dir_raw.is_empty() {
        return false;
    }

    let common_dir_result = git_raw(repo, &["rev-parse", "--git-common-dir"], None).await;
    if common_dir_result.code != 0 {
        return false;
    }
    let common_dir_raw = common_dir_result.stdout.trim();
    if common_dir_raw.is_empty() {
        return false;
    }
    let common_dir_abs = if Path::new(common_dir_raw).is_absolute() {
        common_dir_raw.to_string()
    } else {
        repo.join(common_dir_raw).to_string_lossy().into_owned()
    };

    if canonical_comparable_path(Path::new(&git_dir_raw)).await
        == canonical_comparable_path(Path::new(&common_dir_abs)).await
    {
        let expected_dot_git = repo.join(".git");
        if canonical_comparable_path(Path::new(&common_dir_abs)).await
            == canonical_comparable_path(&expected_dot_git).await
        {
            return true;
        }
        return dot_git_points_to(repo, &common_dir_abs).await;
    }

    let worktrees_admin_root = Path::new(&common_dir_abs).join("worktrees");
    let prefix = format!(
        "{}{}",
        canonical_comparable_path(&worktrees_admin_root).await,
        std::path::MAIN_SEPARATOR
    );
    if !canonical_comparable_path(Path::new(&git_dir_raw))
        .await
        .starts_with(&prefix)
    {
        return false;
    }
    dot_git_points_to(repo, &git_dir_raw).await
}

enum RootContainment {
    Inside,
    OutsideMissing,
}

/// Shared by both the registered and orphan removal paths: a corrupted or hand-edited registry
/// entry naming a path outside this repository's own worktrees can never reach either removal
/// path. `OutsideMissing` is returned (rather than letting the call continue) when the path is
/// outside the root AND does not exist -- the caller must never force-remove a path outside the
/// root that git still has registered (e.g. a disconnected drive), destroying another worktree.
async fn assert_within_worktrees_root(
    repo: &Path,
    worktree_path: &Path,
) -> Result<RootContainment, GitError> {
    let root = worktrees_root(repo);
    let root_key = comparable_path(&root.to_string_lossy());
    let target_key = comparable_path(&worktree_path.to_string_lossy());
    if target_key == root_key {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            outside_worktrees_root_message(worktree_path, &root, repo, true),
        ));
    }
    let prefix = format!("{root_key}{}", std::path::MAIN_SEPARATOR);
    if target_key.starts_with(&prefix) {
        return Ok(RootContainment::Inside);
    }
    match lstat_optional(worktree_path).await? {
        Some(_) => Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            outside_worktrees_root_message(worktree_path, &root, repo, false),
        )),
        None => Ok(RootContainment::OutsideMissing),
    }
}

/// Issue #599 step 3, split by issue #891 (git metadata contract: "resolve the admin entry
/// BEFORE any file is deleted"): finds, but does not remove, the one admin directory under
/// `<gitCommonDir>/worktrees/` whose `gitdir` file canonicalises to `<worktreePath>/.git` --
/// never a repo-wide `git worktree prune`, which would drop every OTHER stale admin entry too.
/// Refuses (nothing removed, nothing even looked at on disk yet) if the entry is locked, or if
/// zero or more than one candidate matches.
async fn find_admin_entry_for(repo: &Path, worktree_path: &Path) -> Result<PathBuf, GitError> {
    let admin_root = git_common_dir(repo).await?.join("worktrees");
    let wanted_git_file = comparable_path(&worktree_path.join(".git").to_string_lossy());
    let mut entries = match tokio::fs::read_dir(&admin_root).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                admin_entry_refusal_message(worktree_path),
            ))
        }
        Err(e) => return Err(wrap_fs_error(e, worktree_path)),
    };
    let mut matches: Vec<PathBuf> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| wrap_fs_error(e, worktree_path))?
    {
        let entry_dir = entry.path();
        let recorded = match tokio::fs::read_to_string(entry_dir.join("gitdir")).await {
            Ok(c) => c.trim().to_string(),
            Err(_) => continue,
        };
        let recorded_abs = if Path::new(&recorded).is_absolute() {
            PathBuf::from(&recorded)
        } else {
            entry_dir.join(&recorded)
        };
        if comparable_path(&recorded_abs.to_string_lossy()) == wanted_git_file {
            matches.push(entry_dir);
        }
    }
    if matches.len() != 1 {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            admin_entry_refusal_message(worktree_path),
        ));
    }
    let admin_entry = matches.into_iter().next().expect("length checked above");
    let locked = tokio::fs::symlink_metadata(admin_entry.join("locked"))
        .await
        .is_ok();
    if locked {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            locked_worktree_message(worktree_path),
        ));
    }
    let admin_root_key = comparable_path(&admin_root.to_string_lossy());
    let entry_key = comparable_path(&admin_entry.to_string_lossy());
    let prefix = format!("{admin_root_key}{}", std::path::MAIN_SEPARATOR);
    if entry_key == admin_root_key || !entry_key.starts_with(&prefix) {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            admin_entry_refusal_message(worktree_path),
        ));
    }
    Ok(admin_entry)
}

/// Removes an already-resolved admin entry (see `find_admin_entry_for`, which performs every
/// committed match/locked/containment check above before this ever runs).
async fn remove_admin_entry(admin_entry: &Path, worktree_path: &Path) -> Result<(), GitError> {
    tokio::fs::remove_dir_all(admin_entry)
        .await
        .map_err(|e| wrap_fs_error(e, worktree_path))
}

/// Issue #599 step 3, rewritten by issue #891: removes an UNREGISTERED worktree folder, never a
/// registered one. Returns `true` if it actually removed something. A real directory's entire
/// contents are removed via `fs::remove_tree` (long-path-safe, never follows a link) regardless
/// of what is in it -- this folder lives inside Refract's own exclusive worktrees root, so
/// anything found there is leftover Refract-generated content (node_modules, build output, a
/// stale `.git` pointer), never used by anything else.
async fn remove_orphaned_worktree_folder(
    repo: &Path,
    worktree_path: &Path,
) -> Result<bool, GitError> {
    let Some(meta) = lstat_optional(worktree_path).await? else {
        return Ok(false);
    };
    if meta.file_type().is_symlink() {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            orphan_refusal_message(worktree_path, OrphanRefusalReason::IsALink),
        ));
    }
    if !meta.is_dir() {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            orphan_refusal_message(worktree_path, OrphanRefusalReason::NotADirectory),
        ));
    }
    let root = worktrees_root(repo);
    remove_tree(worktree_path, &root)
        .await
        .map_err(|err| map_remove_tree_error(err, worktree_path))?;
    Ok(true)
}

/// `git branch -D`'s own "used by worktree at '<path>'" message names the OTHER checkout as
/// DISPLAY TEXT ONLY -- never read, never `lstat`'d, never passed to any further git/fs call.
/// ASCII-only lowercasing (`to_ascii_lowercase`, never `to_lowercase`) keeps the search offset
/// byte-identical to the original string so slicing it afterwards cannot land mid-character.
fn extract_used_by_worktree_path(stderr: &str) -> Option<String> {
    let marker = "used by worktree at '";
    let lower = stderr.to_ascii_lowercase();
    let idx = lower.find(marker)?;
    let rest = &stderr[idx + marker.len()..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

async fn delete_branch_if_requested(
    repo: &Path,
    branch: &str,
    delete_branch: bool,
    removed_worktree: bool,
) -> Result<(), GitError> {
    if !delete_branch || !branch_exists(repo, branch).await {
        return Ok(());
    }
    let result = git_raw(repo, &["branch", "-D", "--", branch], None).await;
    if result.code == 0 {
        return Ok(());
    }
    if !result.stderr.to_lowercase().contains("used by worktree") {
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            format!("git branch -D failed: {}", result.stderr.trim()),
        ));
    }
    let holder_path = extract_used_by_worktree_path(&result.stderr);
    let holder_key = holder_path.as_deref().map(comparable_path);
    let repo_key = comparable_path(&repo.to_string_lossy());
    let common_dir_key = git_common_dir(repo)
        .await
        .ok()
        .map(|d| comparable_path(&d.to_string_lossy()));
    let is_main_checkout = holder_key
        .as_ref()
        .map(|h| *h == repo_key || Some(h.clone()) == common_dir_key)
        .unwrap_or(false);
    let removed_clause = if removed_worktree {
        "Refract removed the worktree but did not delete"
    } else {
        "Refract did not delete"
    };
    let where_clause = if is_main_checkout {
        format!(" at {}", normalize_git_path(&repo.to_string_lossy()))
    } else if let Some(h) = &holder_path {
        format!(" at {}", normalize_git_path(h))
    } else {
        " elsewhere".to_string()
    };
    let next_step = if is_main_checkout {
        "Switch that checkout to a different branch, then choose Delete again."
    } else {
        "Switch that checkout to a different branch (or, if its drive is connected and you no longer need it, remove that worktree), then choose Delete again."
    };
    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        format!("{removed_clause} branch {branch}: it is checked out{where_clause}. {next_step}"),
    ))
}

/// Removes a Session's worktree however it currently stands (issue #599): the single entry
/// point `sessions.delete` calls instead of picking its own path with `fs.stat`. Idempotent by
/// construction: whatever step a previous call threw on, this re-reads live git/filesystem state
/// from scratch rather than trusting anything cached.
pub async fn remove_session_worktree(
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
    delete_branch: bool,
) -> Result<(), GitError> {
    if let Some(meta) = lstat_optional(worktree_path).await? {
        if meta.file_type().is_symlink() {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                orphan_refusal_message(worktree_path, OrphanRefusalReason::IsALink),
            ));
        }
    }

    let containment = assert_within_worktrees_root(repo, worktree_path).await?;

    if !is_repo_readable(repo).await {
        let worktree_gone = lstat_optional(worktree_path).await?.is_none();
        if worktree_gone {
            return Ok(());
        }
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            format!(
                "Refract did not delete anything. It could not read the repository at {} (moved, deleted, or no longer a git repository?), and the worktree folder {} still exists. Restore the repository, or move that folder somewhere safe yourself, then choose Delete again.",
                repo.display(),
                worktree_path.display()
            ),
        ));
    }

    if matches!(containment, RootContainment::OutsideMissing) {
        if is_worktree_registered(repo, worktree_path).await {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                format!(
                    "Refract did not delete anything. Git still records a worktree for this Session at {}, outside Refract's worktree folder, and that folder cannot be found (a disconnected drive, or moved?). Refract never removes worktrees outside its own folder. If git says the worktree is locked, run `git worktree unlock` followed by that path first. If you no longer need it, run `git worktree remove --force` followed by that path in the repository at {}, then choose Delete again. If the drive is connected when you run it, this also deletes that folder and any uncommitted work in it.",
                    worktree_path.display(),
                    normalize_git_path(&repo.to_string_lossy())
                ),
            ));
        }
        delete_branch_if_requested(repo, branch, delete_branch, false).await?;
        return Ok(());
    }

    let registered = is_worktree_registered(repo, worktree_path).await;

    if registered {
        // Issue #891 git metadata contract: resolve the ONE admin entry this removal will
        // touch BEFORE any file is deleted -- an ambiguous, locked, or unresolvable entry
        // refuses here, with every file still in place, rather than after they are already
        // gone.
        let admin_entry = find_admin_entry_for(repo, worktree_path).await?;

        // Covers all three shapes a "registered" worktree can be in today: a live checkout full
        // of real files, one hand-emptied of its `.git` pointer with files left behind, and one
        // whose folder is missing entirely (git still lists it, but there is nothing on disk --
        // the "registered, folder missing" case the git metadata contract calls out explicitly).
        // `fs::remove_tree` is long-path-safe and never follows a link, so a full `node_modules`
        // tree is removed exactly like an empty one; `git worktree remove --force` is never
        // called at all any more.
        let folder_present = lstat_optional(worktree_path).await?.is_some();
        if folder_present {
            let root = worktrees_root(repo);
            remove_tree(worktree_path, &root)
                .await
                .map_err(|err| map_remove_tree_error(err, worktree_path))?;
        }

        remove_admin_entry(&admin_entry, worktree_path).await?;

        // Verify with `git worktree list --porcelain` (never `git worktree prune`, which would
        // also drop every OTHER stale admin entry): if git still lists this path after its own
        // admin entry is gone, something is wrong with git's own cache -- stop here rather than
        // delete the branch out from under a worktree git still thinks exists.
        if is_worktree_registered(repo, worktree_path).await {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                format!(
                    "Refract removed {}'s files and its own git admin entry, but git still lists it as a worktree. Run `git worktree list` yourself to check, then choose Delete again.",
                    worktree_path.display()
                ),
            ));
        }

        delete_branch_if_requested(repo, branch, delete_branch, folder_present).await?;
        return Ok(());
    }

    let removed_folder = remove_orphaned_worktree_folder(repo, worktree_path).await?;
    delete_branch_if_requested(repo, branch, delete_branch, removed_folder).await
}

#[cfg(test)]
#[path = "worktree_delete_tests.rs"]
mod tests;
