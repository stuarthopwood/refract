// Port of `src/main/git/worktrees.ts`: worktree lifecycle for a Session (data-model.md
// `Session.worktreePath`/`branch`, tasks.md T011, T016, and lane R2's own #785, folding in
// #729/#656). One Session = one git worktree, created under
// `<repo>/../pinion-worktrees/<repoName>/<name>`. Creation (this file), the #599 safe-delete
// path (`git/worktree_delete.rs`), and the #729 validity check (`git/worktree_validity.rs`)
// are split across three files to stay under the 600-line soft cap each; recreation
// (`recreate_worktree`, below) stays here since it is a creation operation, not a removal one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::git::{git, git_raw, GitError, GitErrorCode};

/// Picks a uniformly-random index in `0..len` without the `rand` crate (not a dependency of
/// this build, Cargo.toml's own dependency list): four bytes from a fresh random UUID v4 (the
/// `uuid` crate, already a dependency, pulls OS randomness via `getrandom` the same way `rand`
/// would) folded into a `u32` and reduced mod `len`.
fn random_index(len: usize) -> usize {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let word = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    (word as usize) % len
}

const ADJECTIVES: &[&str] = &[
    "amber", "ancient", "auburn", "bold", "brave", "bright", "brisk", "calm", "clever", "cosmic",
    "crisp", "curious", "daring", "earnest", "eager", "fleet", "fluent", "fond", "frosty",
    "gallant", "gentle", "golden", "humble", "keen", "lively", "lucid", "lucky", "mellow", "merry",
    "mighty", "nimble", "noble", "placid", "quiet", "quick", "radiant", "rustic", "silent",
    "sunny", "swift",
];

const NOUNS: &[&str] = &[
    "otter", "falcon", "badger", "heron", "lynx", "sparrow", "raven", "fox", "wolf", "hawk",
    "panther", "orca", "marten", "stoat", "bison", "gazelle", "ibex", "crane", "egret", "martin",
    "kestrel", "osprey", "puffin", "tern", "finch", "wren", "lark", "dove", "swan", "stork",
    "plover", "harrier", "merlin", "kite", "owl", "vole", "hare", "seal", "walrus", "beaver",
];

/// The directory that holds every worktree for `repo`: `<repo>/../pinion-worktrees/<repoName>`.
pub fn worktrees_root(repo: &Path) -> PathBuf {
    let repo_name = repo
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    repo.join("..").join("pinion-worktrees").join(repo_name)
}

pub async fn list_branches(repo: &Path) -> Result<Vec<String>, GitError> {
    let stdout = git(
        repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await?;
    Ok(stdout
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub async fn branch_exists(repo: &Path, branch: &str) -> bool {
    let result = git_raw(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        None,
    )
    .await;
    result.code == 0
}

/// Reads `origin/HEAD`, falling back to the current branch, then `main`, then `master`,
/// whichever exists (T011).
pub async fn default_branch(repo: &Path) -> Result<String, GitError> {
    let symbolic = git_raw(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        None,
    )
    .await;
    if symbolic.code == 0 {
        let reference = symbolic.stdout.trim();
        if !reference.is_empty() {
            return Ok(match reference.find('/') {
                Some(slash) => reference[slash + 1..].to_string(),
                None => reference.to_string(),
            });
        }
    }

    let current = git_raw(repo, &["symbolic-ref", "--short", "HEAD"], None).await;
    if current.code == 0 && !current.stdout.trim().is_empty() {
        return Ok(current.stdout.trim().to_string());
    }

    if branch_exists(repo, "main").await {
        return Ok("main".to_string());
    }
    if branch_exists(repo, "master").await {
        return Ok("master".to_string());
    }

    Err(GitError::new(
        GitErrorCode::GitFailed,
        format!(
            "Could not determine a default branch for {}",
            repo.display()
        ),
    ))
}

pub struct AddWorktreeResult {
    pub worktree_path: PathBuf,
    pub branch: String,
}

/// Issue #656 (folded into lane R2, #785): creates a worktree with a freshly generated, unique
/// name, replacing the former two-step `generateName` then `addWorktree` -- a gap between
/// picking a candidate name and creating it let two concurrent Session creates settle on the
/// SAME candidate, and the loser's own failure cleanup then force-removed the WINNER'S
/// just-created worktree and branch (`git worktree remove --force` + `branch -D` on a name this
/// attempt never actually created -- real data loss). Fixed by making `git branch <candidate>
/// <base>` itself the atomic reservation: git's own ref lock lets at most one concurrent caller
/// ever create a given branch name, so a collision is detected with NOTHING yet created by the
/// losing attempt (nothing to clean up, no risk of deleting someone else's worktree); only
/// after that reservation succeeds does this attach the worktree to the now-exclusively-owned
/// branch (no `-b`), and only a failure PAST that point is ever this attempt's own to clean up.
pub async fn add_worktree_with_generated_name(
    repo: &Path,
    base_branch: &str,
) -> Result<AddWorktreeResult, GitError> {
    let existing_branches: HashSet<String> = list_branches(repo).await?.into_iter().collect();
    let mut existing_folders = HashSet::new();
    match tokio::fs::read_dir(worktrees_root(repo)).await {
        Ok(mut entries) => {
            while let Some(entry) = entries.next_entry().await? {
                if let Some(name) = entry.file_name().to_str() {
                    existing_folders.insert(name.to_string());
                }
            }
        }
        Err(err) if crate::store::atomic_json::is_enoent(&err) => {}
        Err(err) => return Err(err.into()),
    }

    let max_attempts = ADJECTIVES.len() * NOUNS.len();
    for attempt in 0..max_attempts.max(64) {
        let candidate = if attempt < max_attempts {
            // First pass: prefer a name neither local branches nor the worktrees-root folder
            // already show, purely as a faster first hit -- the reservation below is what
            // actually makes the choice safe, not this pre-filter.
            loop {
                let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
                let noun = NOUNS[random_index(NOUNS.len())];
                let generated = format!("{adjective}-{noun}");
                if !existing_branches.contains(&generated) && !existing_folders.contains(&generated) {
                    break generated;
                }
            }
        } else {
            // All 1,600 combinations are contended (practically unreachable): disambiguate with
            // a short random suffix, same as the former `generateName`'s own fallback.
            let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
            let noun = NOUNS[random_index(NOUNS.len())];
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            format!("{adjective}-{noun}-{}", &suffix[0..4])
        };

        let reservation = git_raw(repo, &["branch", "--", &candidate, base_branch], None).await;
        if reservation.code != 0 {
            if is_branch_exists_error(&reservation.stderr) {
                continue; // Someone else owns this name; nothing of ours to clean up.
            }
            return Err(map_add_worktree_error(
                &reservation.stderr,
                &worktrees_root(repo).join(&candidate),
            ));
        }

        // We now exclusively own the branch `candidate`: any failure from here is ours alone to
        // clean up, never another attempt's.
        let worktree_path = worktrees_root(repo).join(&candidate);
        if let Some(parent) = worktree_path.parent() {
            if let Err(err) = tokio::fs::create_dir_all(parent).await {
                git_raw(repo, &["branch", "-D", "--", &candidate], None).await;
                if is_path_too_long_error(&err.to_string(), err.raw_os_error()) {
                    return Err(GitError::new(
                        GitErrorCode::PathTooLong,
                        format!("Worktree path too long: {}", worktree_path.display()),
                    ));
                }
                return Err(err.into());
            }
        }
        let worktree_path_str = worktree_path.to_string_lossy().into_owned();
        let result = git_raw(
            repo,
            &["worktree", "add", "--", &worktree_path_str, &candidate],
            None,
        )
        .await;
        if result.code != 0 {
            git_raw(
                repo,
                &["worktree", "remove", "--force", "--", &worktree_path_str],
                None,
            )
            .await;
            let _ = tokio::fs::remove_dir_all(&worktree_path).await;
            git_raw(repo, &["branch", "-D", "--", &candidate], None).await;
            return Err(map_add_worktree_error(&result.stderr, &worktree_path));
        }
        return Ok(AddWorktreeResult {
            worktree_path,
            branch: candidate,
        });
    }

    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        "Could not find a free Session name: every candidate is already taken".to_string(),
    ))
}

/// True when `git branch`'s own failure means "this name is already taken" -- the one collision
/// class worth retrying a fresh candidate for; any other failure (an invalid base branch, a
/// corrupt repository) is a real error the caller should surface immediately rather than
/// silently retry up to 1,600 times.
fn is_branch_exists_error(stderr: &str) -> bool {
    stderr.to_lowercase().contains("already exists")
}

fn map_add_worktree_error(stderr: &str, worktree_path: &Path) -> GitError {
    let text = stderr.to_lowercase();
    if text.contains("invalid reference")
        || text.contains("unknown revision")
        || text.contains("is not a valid object name")
        || text.contains("not a valid branch")
    {
        return GitError::new(
            GitErrorCode::BaseMissing,
            format!("Base branch not found: {}", stderr.trim()),
        );
    }
    let path_str = worktree_path.to_string_lossy();
    if is_path_too_long_error(stderr, None) || path_str.len() >= 260 {
        return GitError::new(
            GitErrorCode::PathTooLong,
            format!("Worktree path too long: {path_str}"),
        );
    }
    let detail = stderr.trim();
    let message = if detail.is_empty() {
        format!("git worktree add failed for {path_str}")
    } else {
        detail.to_string()
    };
    GitError::new(GitErrorCode::WorktreeFailed, message)
}

/// Mirrors `worktrees.ts`'s own `isPathTooLongError`: a Windows `ENAMETOOLONG`-equivalent raw OS
/// error code (`206`, `ERROR_FILENAME_EXCED_RANGE`) or a "file name too long" message fragment.
fn is_path_too_long_error(message: &str, raw_os_error: Option<i32>) -> bool {
    raw_os_error == Some(206)
        || message.to_lowercase().contains("file name too long")
        || message.to_lowercase().contains("filename too long")
}

/// Removes the worktree with `git worktree remove --force`, then the branch only when asked.
/// Used by `sessions.create`'s own rollback path when `RegistryStore::add_session` fails after
/// `add_worktree_with_generated_name` already succeeded (a Repository removed mid-flight, the
/// same race `RegistryStore::add_session`'s own doc comment describes).
pub async fn remove_worktree(
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
    delete_branch: bool,
) -> Result<(), GitError> {
    let worktree_path_str = worktree_path.to_string_lossy().into_owned();
    let result = git_raw(
        repo,
        &["worktree", "remove", "--force", "--", &worktree_path_str],
        None,
    )
    .await;
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else {
            result.stdout.trim()
        };
        return Err(GitError::new(
            GitErrorCode::WorktreeFailed,
            format!("git worktree remove failed: {detail}"),
        ));
    }
    if delete_branch {
        git(repo, &["branch", "-D", "--", branch]).await?;
    }
    Ok(())
}

/// Recreates a worktree at its original path, attaching the existing `branch` (no `-b`): used
/// when the worktree folder has disappeared but the branch is intact (tasks.md T043, issue
/// #785's `sessions.recreateWorktree`). Callers check `branch_exists` first; this only maps the
/// `git worktree add` failure itself. `-f` is required (not merely permissive): git still has
/// the original worktree registered under `.git/worktrees/<name>/` even though its directory is
/// gone, and a plain `add` refuses with "is a missing but already registered worktree" until
/// `-f`, `prune`, or `remove` clears it.
pub async fn recreate_worktree(
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), GitError> {
    if let Some(parent) = worktree_path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            if is_path_too_long_error(&err.to_string(), err.raw_os_error()) {
                return Err(GitError::new(
                    GitErrorCode::PathTooLong,
                    format!("Worktree path too long: {}", worktree_path.display()),
                ));
            }
            return Err(err.into());
        }
    }

    let worktree_path_str = worktree_path.to_string_lossy().into_owned();
    let result = git_raw(
        repo,
        &["worktree", "add", "-f", "--", &worktree_path_str, branch],
        None,
    )
    .await;
    if result.code != 0 {
        let path_str = worktree_path.to_string_lossy();
        if is_path_too_long_error(&result.stderr, None) || path_str.len() >= 260 {
            return Err(GitError::new(
                GitErrorCode::PathTooLong,
                format!("Worktree path too long: {path_str}"),
            ));
        }
        let detail = result.stderr.trim();
        let message = if detail.is_empty() {
            format!("git worktree add failed for {path_str}")
        } else {
            detail.to_string()
        };
        return Err(GitError::new(GitErrorCode::WorktreeFailed, message));
    }
    Ok(())
}
