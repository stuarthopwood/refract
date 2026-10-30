// Worktree lifecycle for a Session: one Session = one git worktree under
// `<repo>/../pinion-worktrees/<repoName>/<name>`. Delete and validity live in sibling files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::git::{git, git_raw, GitError, GitErrorCode};

/// Picks a random index in `0..len` from a fresh UUID v4 (`rand` is not a dependency).
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

/// Reads `origin/HEAD`, falling back to the current branch, then `main`, then `master`.
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

#[derive(Debug)]
pub struct AddWorktreeResult {
    pub worktree_path: PathBuf,
    pub branch: String,
}

/// Creates a worktree under a fresh unique name. `git branch` is the atomic reservation and the
/// leaf dir uses non-recursive `create_dir`, so a losing racer never removes the winner's work
/// (#656). Name checks are case-insensitive (Windows).
pub async fn add_worktree_with_generated_name(
    repo: &Path,
    base_branch: &str,
) -> Result<AddWorktreeResult, GitError> {
    let existing_branches: HashSet<String> = list_branches(repo)
        .await?
        .into_iter()
        .map(|b| b.to_lowercase())
        .collect();
    let mut existing_folders = HashSet::new();
    match tokio::fs::read_dir(worktrees_root(repo)).await {
        Ok(mut entries) => {
            while let Some(entry) = entries.next_entry().await? {
                if let Some(name) = entry.file_name().to_str() {
                    existing_folders.insert(name.to_lowercase());
                }
            }
        }
        Err(err) if crate::store::atomic_json::is_enoent(&err) => {}
        Err(err) => return Err(err.into()),
    }

    let max_attempts = ADJECTIVES.len() * NOUNS.len();
    for attempt in 0..max_attempts.max(64) {
        let candidate = if attempt < max_attempts {
            let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
            let noun = NOUNS[random_index(NOUNS.len())];
            format!("{adjective}-{noun}")
        } else {
            // All 1,600 combinations contended: fall back to a random suffix.
            let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
            let noun = NOUNS[random_index(NOUNS.len())];
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            format!("{adjective}-{noun}-{}", &suffix[0..4])
        };

        // Cheap pre-filter only; the branch reservation is what makes the choice race-safe.
        if attempt < max_attempts
            && (existing_branches.contains(&candidate.to_lowercase())
                || existing_folders.contains(&candidate.to_lowercase()))
        {
            continue;
        }

        match try_reserve_and_create(repo, base_branch, &candidate).await? {
            CandidateOutcome::Created(result) => return Ok(result),
            CandidateOutcome::Collision => continue,
        }
    }

    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        "Could not find a free Session name: every candidate is already taken".to_string(),
    ))
}

/// Same reserve-then-create path as the generated-name variant, over a caller-supplied candidate
/// sequence (used for deterministic `pr-<n>` names; a name pre-check alone isn't race-safe).
pub(crate) async fn add_worktree_with_candidates(
    repo: &Path,
    base_branch: &str,
    candidates: impl IntoIterator<Item = String>,
) -> Result<AddWorktreeResult, GitError> {
    for candidate in candidates {
        match try_reserve_and_create(repo, base_branch, &candidate).await? {
            CandidateOutcome::Created(result) => return Ok(result),
            CandidateOutcome::Collision => continue,
        }
    }
    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        "No candidate in the supplied sequence succeeded".to_string(),
    ))
}

enum CandidateOutcome {
    Created(AddWorktreeResult),
    Collision,
}

/// Reserves `candidate` as a branch, then creates its worktree; `Collision` when the branch or
/// leaf folder is taken. Failure cleanup removes only what this call created, never force or
/// recursive.
async fn try_reserve_and_create(
    repo: &Path,
    base_branch: &str,
    candidate: &str,
) -> Result<CandidateOutcome, GitError> {
    let reservation = git_raw(repo, &["branch", "--", candidate, base_branch], None).await;
    if reservation.code != 0 {
        if is_branch_exists_error(&reservation.stderr) {
            return Ok(CandidateOutcome::Collision);
        }
        return Err(map_add_worktree_error(
            &reservation.stderr,
            &worktrees_root(repo).join(candidate),
        ));
    }

    // We own the branch now; failures below clean up only our own artefacts.
    let worktree_path = worktrees_root(repo).join(candidate);
    if let Some(parent) = worktree_path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            cleanup_reserved_branch(repo, candidate).await;
            if is_path_too_long_error(&err.to_string(), err.raw_os_error()) {
                return Err(GitError::new(
                    GitErrorCode::PathTooLong,
                    format!("Worktree path too long: {}", worktree_path.display()),
                ));
            }
            return Err(err.into());
        }
    }

    // Non-recursive: a pre-existing folder is a collision (`AlreadyExists`) and is left untouched.
    match tokio::fs::create_dir(&worktree_path).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            cleanup_reserved_branch(repo, candidate).await;
            return Ok(CandidateOutcome::Collision);
        }
        Err(err) => {
            cleanup_reserved_branch(repo, candidate).await;
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
        &["worktree", "add", "--", &worktree_path_str, candidate],
        None,
    )
    .await;
    if result.code != 0 {
        // Non-recursive `remove_dir` fails (logged) if git left content, rather than force-deleting it.
        if let Err(cleanup_err) = tokio::fs::remove_dir(&worktree_path).await {
            log::warn!(
                "add_worktree_with_generated_name: could not remove the empty leaf directory {} after a failed `git worktree add`: {cleanup_err}",
                worktree_path.display()
            );
        }
        cleanup_reserved_branch(repo, candidate).await;
        return Err(map_add_worktree_error(&result.stderr, &worktree_path));
    }
    Ok(CandidateOutcome::Created(AddWorktreeResult {
        worktree_path,
        branch: candidate.to_string(),
    }))
}

/// Removes a branch this call just reserved; logs failures since a leak is worth knowing about.
async fn cleanup_reserved_branch(repo: &Path, candidate: &str) {
    if let Err(err) = git(repo, &["branch", "-D", "--", candidate]).await {
        log::warn!(
            "add_worktree_with_generated_name: could not remove the reserved branch {candidate} during cleanup: {err}"
        );
    }
}

/// True when `git branch` failed because the name is taken, or on transient "cannot lock ref"
/// contention from concurrent calls; both are worth retrying with a fresh candidate.
fn is_branch_exists_error(stderr: &str) -> bool {
    let text = stderr.to_lowercase();
    text.contains("already exists") || text.contains("cannot lock ref")
}

fn map_add_worktree_error(stderr: &str, worktree_path: &Path) -> GitError {
    let text = stderr.to_lowercase();
    if text.contains("invalid reference")
        || text.contains("unknown revision")
        || text.contains("not a valid object name")
        || text.contains("not a valid branch")
    {
        return GitError::new(
            GitErrorCode::BaseMissing,
            format!(
                "Base branch not found: {}",
                crate::omp::redact::redact_secrets(stderr.trim())
            ),
        );
    }
    let path_str = worktree_path.to_string_lossy();
    if is_path_too_long_error(stderr, None) || path_str.len() >= 260 {
        return GitError::new(
            GitErrorCode::PathTooLong,
            format!("Worktree path too long: {path_str}"),
        );
    }
    let detail = crate::omp::redact::redact_secrets(stderr.trim());
    let message = if detail.is_empty() {
        format!("git worktree add failed for {path_str}")
    } else {
        detail
    };
    GitError::new(GitErrorCode::WorktreeFailed, message)
}

/// True for a Windows path-too-long error (raw OS code `206`) or a "file name too long" message.
fn is_path_too_long_error(message: &str, raw_os_error: Option<i32>) -> bool {
    raw_os_error == Some(206)
        || message.to_lowercase().contains("file name too long")
        || message.to_lowercase().contains("filename too long")
}

/// Removes the worktree with `git worktree remove --force`, then the branch only when asked.
/// Used to roll back `sessions.create` when `add_session` fails after the worktree was made.
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
        let detail = crate::omp::redact::redact_secrets(if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else {
            result.stdout.trim()
        });
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

/// Creates a worktree for a pull request's head. Fetches into a call-scoped temp ref (not a
/// name-based branch) then reserves `pr-<n>`, `pr-<n>-2`, ... atomically, so concurrent calls
/// for the same PR can't destroy each other's worktree.
pub async fn add_worktree_from_pull_request_branch(
    repo: &Path,
    number: u64,
) -> Result<AddWorktreeResult, GitError> {
    let temp_ref = format!("refs/pinion/tmp/{}", uuid::Uuid::new_v4());
    let fetch_result = git_raw(
        repo,
        &["fetch", "origin", &format!("pull/{number}/head:{temp_ref}")],
        None,
    )
    .await;
    let result = if fetch_result.code != 0 {
        Err(GitError::new(
            GitErrorCode::CheckoutFailed,
            if fetch_result.stderr.trim().is_empty() {
                format!("Could not fetch pull request #{number}'s head branch.")
            } else {
                crate::omp::redact::redact_secrets(fetch_result.stderr.trim())
            },
        ))
    } else {
        let base = format!("pr-{number}");
        const MAX_ATTEMPTS: u32 = 1000;
        let candidates = std::iter::once(base.clone())
            .chain((2..=MAX_ATTEMPTS).map(move |suffix| format!("{base}-{suffix}")));
        add_worktree_with_candidates(repo, &temp_ref, candidates).await
    };

    // Scratch ref, always deleted; a missing ref (fetch failed early) is expected, so debug-log only.
    if let Err(err) = git(repo, &["update-ref", "-d", &temp_ref]).await {
        log::debug!(
            "add_worktree_from_pull_request_branch: no temporary fetch ref {temp_ref} to remove (or removal failed): {err}"
        );
    }

    result
}

/// Recreates a worktree at its original path, attaching the existing `branch` (no `-b`).
/// `-f` is required: git still has the missing worktree registered and a plain `add` refuses.
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

#[cfg(test)]
#[path = "worktrees_tests.rs"]
mod tests;
