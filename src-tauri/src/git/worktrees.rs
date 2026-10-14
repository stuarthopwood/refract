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

#[derive(Debug)]
pub struct AddWorktreeResult {
    pub worktree_path: PathBuf,
    pub branch: String,
}

/// Issue #656 (folded into lane R2, #785): creates a worktree with a freshly generated, unique
/// name, replacing the former two-step `generateName` then `addWorktree` -- a gap between
/// picking a candidate name and creating it let two concurrent Session creates settle on the
/// SAME candidate, and the loser's own failure cleanup then force-removed the WINNER'S
/// just-created worktree and branch (`git worktree remove --force` + `branch -D` on a name this
/// attempt never actually created -- real data loss). Fixed two ways: (1) `git branch
/// <candidate> <base>` is itself the atomic reservation -- git's own ref lock lets at most one
/// concurrent caller ever create a given branch name, so a collision is detected with NOTHING
/// yet created by the losing attempt; (2) the leaf worktree folder is created with a
/// non-recursive `create_dir` (never `create_dir_all`/`remove_dir_all` on the leaf), so a
/// pre-existing folder at that path (an unrelated leftover, nothing to do with this attempt)
/// is detected via `AlreadyExists` and never touched, let alone recursively deleted -- cleanup
/// after ANY failure past the branch reservation removes only the branch (ours, just reserved)
/// and, if we created it, the now-known-empty leaf directory (never force, never recursive).
/// Name comparisons against existing branches/folders are case-insensitive (Windows' own
/// filesystem semantics; git's loose-ref files share the same hazard).
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
            // All 1,600 combinations are contended (practically unreachable): disambiguate with
            // a short random suffix, same as the former `generateName`'s own fallback.
            let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
            let noun = NOUNS[random_index(NOUNS.len())];
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            format!("{adjective}-{noun}-{}", &suffix[0..4])
        };

        // Cheap pre-filter (bounded, never loops): a candidate already visible in local
        // branches or the worktrees-root folder is skipped WITHOUT a `git branch` call, purely
        // as a faster first hit for the common case -- the reservation below, not this
        // pre-filter, is what actually makes the final choice safe against a concurrent racer
        // this snapshot cannot see.
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

/// Drives the same reserve-then-create path as `add_worktree_with_generated_name` above, but
/// against a caller-supplied candidate sequence instead of the random generator. Originally a
/// test-only seam (gate round 1, HIGH #656) so a test could force a specific collision and
/// assert the loser's cleanup never touches the winner's artefacts; promoted to a shared,
/// always-compiled engine (gate round 3, HIGH #656 regression, 2026-10-14) for
/// `add_worktree_from_pull_request_branch`'s own deterministic `pr-<n>`/`pr-<n>-2`/... sequence
/// -- that caller needs EXACTLY this function's atomic-reservation safety against a concurrent
/// racer, which a separate "is this name free" pre-check plus a name-based fetch destination
/// does not provide (see that function's own doc comment for the incident this fixed).
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

/// Reserves `candidate` as a branch (the atomic step, see this file's own header) then creates
/// its worktree. Returns `Collision` (nothing touched beyond this attempt's own, already-
/// cleaned-up reservation) when the branch name OR the leaf folder is already taken by something
/// this attempt did not create; any other failure is a real `GitError`. On ANY failure past a
/// successful branch reservation, cleanup removes only what THIS call created: the branch
/// always (`cleanup_reserved_branch`), and the leaf directory only via a non-recursive
/// `remove_dir` (never `remove_dir_all`, never `git worktree remove --force` -- `git worktree
/// add` never got far enough to register anything git itself would need force-removed).
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

    // We now exclusively own the branch `candidate`: any failure from here is ours alone to
    // clean up, never another attempt's.
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

    // Non-recursive and ours alone: a folder already at this exact path (an unrelated leftover,
    // nothing to do with this attempt's own branch reservation) is a name collision at the
    // filesystem level, detected via `AlreadyExists` and left completely untouched -- never
    // deleted, never descended into.
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
        // We created this leaf directory ourselves, empty, moments ago: a non-recursive
        // `remove_dir` is always safe for it. If `git worktree add` left anything inside before
        // failing, `remove_dir` itself fails (logged, not swallowed) rather than guessing it is
        // safe to force-delete unknown content.
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

/// Removes a branch THIS call just reserved (never any other branch): logs rather than
/// swallows a failure, since a leaked reserved branch is worth knowing about even though it
/// cannot cause data loss on its own.
async fn cleanup_reserved_branch(repo: &Path, candidate: &str) {
    if let Err(err) = git(repo, &["branch", "-D", "--", candidate]).await {
        log::warn!(
            "add_worktree_with_generated_name: could not remove the reserved branch {candidate} during cleanup: {err}"
        );
    }
}

/// True when `git branch`'s own failure means "this name is already taken" -- the one collision
/// class worth retrying a fresh candidate for; any other failure (an invalid base branch, a
/// corrupt repository) is a real error the caller should surface immediately rather than
/// silently retry up to 1,600 times. Also treats "cannot lock ref" as a collision (LOW finding,
/// gate round 4, 2026-10-14): many concurrent `git branch` calls against the same repository
/// (several Sessions created in a burst) can trip git's own ref-lock contention transiently --
/// that is not a real failure, and the exact same retry-the-next-candidate behaviour already
/// used for a genuine name collision resolves it just as well.
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

/// Port of `worktrees.ts`'s own `addWorktreeFromPullRequestBranch` (lane R9, issue #792).
///
/// Gate round 3 HIGH regression (code review, 2026-10-14): the previous version pre-checked a
/// candidate name (`pr-<n>`, `pr-<n>-2`, ...) was free via `unique_pull_request_branch_name`
/// (now deleted), then fetched the pull request's head STRAIGHT INTO that chosen name as a real
/// branch. The pre-check reserved nothing: two concurrent `newSessionFromPullRequest` calls for
/// the SAME pull request could both see `pr-<n>` as free, both fetch into it (the identical
/// commit, so neither fetch ever conflicts), and then whichever `git worktree add` lost would
/// run this function's own cleanup -- `remove_worktree`'s `git worktree remove --force` +
/// `branch -D` -- against the name the WINNER had just finished creating, destroying its live
/// worktree and branch.
///
/// Fixed by never giving the fetch a name-based destination at all: the pull request's head is
/// fetched into a call-scoped temporary ref (`refs/pinion/tmp/<uuid>`, deleted again
/// unconditionally before returning), then `add_worktree_with_candidates` runs the SAME
/// atomic-reservation engine `add_worktree_with_generated_name` already relies on
/// (`try_reserve_and_create`: `git branch <candidate> <base>` IS the reservation -- git's own
/// ref lock lets at most one concurrent caller ever create a given branch name, so a collision
/// is detected with nothing yet created by the losing attempt) over the exact `pr-<n>`,
/// `pr-<n>-2`, ... sequence the deleted pre-check used to generate. A loser now simply moves on
/// to the next candidate, the same as two concurrent generated-name Session creates already do.
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

    // Scratch space for this one fetch attempt only, never a Session's real branch -- deleted
    // unconditionally (LOW finding, gate round 4, 2026-10-14: this used to run only on the
    // success/candidate-reservation path, skipped entirely by an early return when the fetch
    // itself failed) regardless of whether the fetch failed before the ref ever existed, the
    // candidate reservation failed, or everything succeeded -- `update-ref -d` on a ref that
    // was never created is a routine, expected outcome here, not a real problem, so it is logged
    // at debug level only. Never `branch -D`: this ref was never created under `refs/heads/`.
    if let Err(err) = git(repo, &["update-ref", "-d", &temp_ref]).await {
        log::debug!(
            "add_worktree_from_pull_request_branch: no temporary fetch ref {temp_ref} to remove (or removal failed): {err}"
        );
    }

    result
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

#[cfg(test)]
#[path = "worktrees_tests.rs"]
mod tests;
