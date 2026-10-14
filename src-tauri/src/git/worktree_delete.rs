// Port of `src/main/git/worktrees.ts`'s issue #599 safe-delete path (folded into lane R2, #785):
// `removeSessionWorktree`. Decides purely from live git/filesystem state (never trusts a stale
// caller-supplied flag), is idempotent (a retry re-reads state from scratch rather than trusting
// anything cached), and never deletes anything outside `worktrees_root(repo)` nor anything `git
// worktree list` does not itself account for. `deleteCheck`/`deleteCheckForMissingWorktree`/
// `deleteCheckForSession` live in the sibling `worktree_delete_check.rs` (same 600-line-per-file
// split reason).
//
// Simplification from the TS source: path comparisons use `worktree_validity::comparable_path`
// (a lexical `.`/`..`-collapse + lowercase, no filesystem touch) instead of TS's
// `fs.realpath`-based `canonicalPath` walk -- the same simplification `store::registry`'s own
// path comparisons already make. A worktree reached only through a separately aliased
// junction/symlink is not specially detected here; every path this module compares is either a
// literal `git worktree list --porcelain` value, a `.git` `gitdir:` record, or the registry's
// own `Session.worktreePath`, never user-supplied.

use std::path::{Path, PathBuf};

use super::git::{git, git_raw, normalize_git_path, GitError, GitErrorCode};
use super::worktree_validity::{comparable_path, is_worktree_registered};
use super::worktrees::{branch_exists, worktrees_root};

enum OrphanRefusalReason {
    NotEmpty,
    RegisteredNotEmpty,
    IsALink,
    NotADirectory,
    InvalidGitEntry,
    ForeignGitdir,
}

fn orphan_refusal_message(worktree_path: &Path, reason: OrphanRefusalReason) -> String {
    let wt = worktree_path.display();
    match reason {
        OrphanRefusalReason::NotEmpty => format!("Refract did not delete anything. The worktree folder {wt} still contains files or folders git no longer tracks. Move anything you want to keep somewhere else, then delete the folder itself (Refract only ever removes an empty folder), then choose Delete again."),
        OrphanRefusalReason::RegisteredNotEmpty => format!("Refract did not delete anything. The worktree folder {wt} is still registered with git, but its own .git file is gone and real files remain. Move or delete them yourself, or restore its .git file, then choose Delete again."),
        OrphanRefusalReason::IsALink => format!("Refract did not delete anything. {wt} is a link, not a worktree folder. Remove only the link itself (in File Explorer delete the link; do not delete its contents), then choose Delete again."),
        OrphanRefusalReason::NotADirectory => format!("Refract did not delete anything. {wt} is a file, not a worktree folder. Remove it yourself, then choose Delete again."),
        OrphanRefusalReason::InvalidGitEntry => format!("Refract did not delete anything. {wt} contains a .git folder or file Refract does not recognise; it may be a separate repository. Check what it is, and if you no longer need it, move the folder somewhere else yourself, then choose Delete again."),
        OrphanRefusalReason::ForeignGitdir => format!("Refract did not delete anything. {wt} contains a .git file that does not point to one of this repository's worktrees. Check it, and if you no longer need it, delete that .git file (or move the folder) yourself, then choose Delete again."),
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
/// plain-language wording naming the worktree path; any other I/O error is wrapped generically
/// rather than leaking a raw OS error message.
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

/// See this file's own header: resolves a relative `gitdir:` record lexically against `dir`
/// itself (TS resolves against `dir`'s realpath instead).
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
    comparable_path(&recorded_abs.to_string_lossy()) == comparable_path(expected)
}

/// Verifies `repo` is its own git toplevel (never an ancestor repository) and that git's own
/// `--absolute-git-dir`/`--git-common-dir` answers tie back to `repo`'s own `.git` entry, not
/// merely to each other. Read-only throughout.
pub(crate) async fn is_repo_readable(repo: &Path) -> bool {
    let toplevel_result = git_raw(repo, &["rev-parse", "--show-toplevel"], None).await;
    if toplevel_result.code != 0 {
        return false;
    }
    let toplevel = toplevel_result.stdout.trim();
    if toplevel.is_empty() || comparable_path(toplevel) != comparable_path(&repo.to_string_lossy())
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

    if comparable_path(&git_dir_raw) == comparable_path(&common_dir_abs) {
        let expected_dot_git = repo.join(".git").to_string_lossy().into_owned();
        if comparable_path(&common_dir_abs) == comparable_path(&expected_dot_git) {
            return true;
        }
        return dot_git_points_to(repo, &common_dir_abs).await;
    }

    let worktrees_admin_root = Path::new(&common_dir_abs)
        .join("worktrees")
        .to_string_lossy()
        .into_owned();
    let prefix = format!(
        "{}{}",
        comparable_path(&worktrees_admin_root),
        std::path::MAIN_SEPARATOR
    );
    if !comparable_path(&git_dir_raw).starts_with(&prefix) {
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
/// path. `OutsideMissing` (rather than permitting the call to continue) is returned when the
/// path is outside the root AND does not exist -- the caller must never run `git worktree remove
/// --force` on a path outside the root that git still has registered (for example a worktree on
/// a disconnected drive), which would otherwise delete that OTHER worktree's entire admin entry.
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

/// A folder can be REGISTERED yet already emptied by hand: its `.git` pointer file deleted while
/// the folder and its git registration both remain. True only when the folder exists, is a real
/// directory, and has no `.git` entry at all.
async fn is_registered_but_hand_emptied(worktree_path: &Path) -> Result<bool, GitError> {
    let Some(meta) = lstat_optional(worktree_path).await? else {
        return Ok(false);
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(false);
    }
    let has_git = tokio::fs::symlink_metadata(worktree_path.join(".git"))
        .await
        .is_ok();
    Ok(!has_git)
}

/// Issue #599 step 3: finds and removes ONLY the one admin directory under
/// `<gitCommonDir>/worktrees/` whose `gitdir` file canonicalises to `<worktreePath>/.git` --
/// never a repo-wide `git worktree prune`, which would drop every OTHER stale admin entry too.
/// Refuses (removes nothing) if the entry is locked, or if zero or more than one candidate
/// matches.
async fn remove_admin_entry_for(repo: &Path, worktree_path: &Path) -> Result<(), GitError> {
    let admin_root = git_common_dir(repo).await?.join("worktrees");
    let wanted_git_file = comparable_path(&worktree_path.join(".git").to_string_lossy());
    let mut entries = match tokio::fs::read_dir(&admin_root).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
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
    tokio::fs::remove_dir_all(&admin_entry)
        .await
        .map_err(|e| wrap_fs_error(e, worktree_path))
}

/// Issue #599 step 3: removes an UNREGISTERED worktree folder, never a registered one. Returns
/// `true` if it actually removed something. Removes the folder only once it is a REAL directory
/// that is then either EMPTY, or holds only a `.git` file pointing strictly inside this
/// repository's own admin area -- never a recursive delete of unknown content.
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
    let mut dir = tokio::fs::read_dir(worktree_path)
        .await
        .map_err(|e| wrap_fs_error(e, worktree_path))?;
    let mut names: Vec<String> = Vec::new();
    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| wrap_fs_error(e, worktree_path))?
    {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    if names.is_empty() {
        tokio::fs::remove_dir(worktree_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        return Ok(true);
    }
    if names.len() == 1 && names[0] == ".git" {
        let git_file_path = worktree_path.join(".git");
        let git_file_meta = tokio::fs::symlink_metadata(&git_file_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        if !git_file_meta.is_file() {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                orphan_refusal_message(worktree_path, OrphanRefusalReason::InvalidGitEntry),
            ));
        }
        let content = tokio::fs::read_to_string(&git_file_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        let Some(gitdir_raw) = content
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))
            .map(str::trim)
        else {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                orphan_refusal_message(worktree_path, OrphanRefusalReason::InvalidGitEntry),
            ));
        };
        let gitdir_abs = if Path::new(gitdir_raw).is_absolute() {
            PathBuf::from(gitdir_raw)
        } else {
            worktree_path.join(gitdir_raw)
        };
        let admin_root = git_common_dir(repo).await?.join("worktrees");
        let admin_root_key = comparable_path(&admin_root.to_string_lossy());
        let prefix = format!("{admin_root_key}{}", std::path::MAIN_SEPARATOR);
        let points_into_this_repo =
            comparable_path(&gitdir_abs.to_string_lossy()).starts_with(&prefix);
        if !points_into_this_repo {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                orphan_refusal_message(worktree_path, OrphanRefusalReason::ForeignGitdir),
            ));
        }
        tokio::fs::remove_file(&git_file_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        tokio::fs::remove_dir(worktree_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        return Ok(true);
    }
    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        orphan_refusal_message(worktree_path, OrphanRefusalReason::NotEmpty),
    ))
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

    if registered && is_registered_but_hand_emptied(worktree_path).await? {
        let mut dir = tokio::fs::read_dir(worktree_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        if dir
            .next_entry()
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?
            .is_some()
        {
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                orphan_refusal_message(worktree_path, OrphanRefusalReason::RegisteredNotEmpty),
            ));
        }
        remove_admin_entry_for(repo, worktree_path).await?;
        tokio::fs::remove_dir(worktree_path)
            .await
            .map_err(|e| wrap_fs_error(e, worktree_path))?;
        delete_branch_if_requested(repo, branch, delete_branch, true).await?;
        return Ok(());
    }

    if registered {
        let worktree_path_str = worktree_path.to_string_lossy().into_owned();
        let result = git_raw(
            repo,
            &["worktree", "remove", "--force", "--", &worktree_path_str],
            None,
        )
        .await;
        if result.code != 0 {
            let stderr = if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else {
                result.stdout.trim().to_string()
            };
            let lower = stderr.to_lowercase();
            if lower.contains("locked working tree") {
                return Err(GitError::new(
                    GitErrorCode::WorktreeFailed,
                    locked_worktree_message(worktree_path),
                ));
            }
            if lower.contains("permission denied")
                || lower.contains("resource busy")
                || lower.contains("being used by another process")
                || lower.contains("access is denied")
            {
                return Err(GitError::new(
                    GitErrorCode::WorktreeFailed,
                    format!("Refract could not finish removing {} because another program may be using it. Close any terminal or editor open in that folder, then choose Delete again.", worktree_path.display()),
                ));
            }
            return Err(GitError::new(
                GitErrorCode::WorktreeFailed,
                format!("git worktree remove failed: {stderr}"),
            ));
        }
        delete_branch_if_requested(repo, branch, delete_branch, true).await?;
        return Ok(());
    }

    let removed_folder = remove_orphaned_worktree_folder(repo, worktree_path).await?;
    delete_branch_if_requested(repo, branch, delete_branch, removed_folder).await
}

#[cfg(test)]
#[path = "worktree_delete_tests.rs"]
mod tests;
