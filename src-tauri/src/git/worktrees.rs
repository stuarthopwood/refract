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

/// Test-only seam (gate round 1, HIGH #656): drives the same reserve-then-create path as
/// `add_worktree_with_generated_name` above, but against a caller-supplied candidate sequence
/// instead of the random generator, so a test can force a specific collision (a pre-created
/// branch/worktree at an exact name) and assert the loser's cleanup never touches it.
#[cfg(test)]
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
/// silently retry up to 1,600 times.
fn is_branch_exists_error(stderr: &str) -> bool {
    stderr.to_lowercase().contains("already exists")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::init_repo;

    #[tokio::test]
    async fn creates_a_worktree_with_a_freshly_generated_unique_name() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        assert!(tokio::fs::metadata(&added.worktree_path)
            .await
            .expect("worktree dir exists")
            .is_dir());
        assert!(!added.branch.is_empty());
        assert!(branch_exists(&repo, &added.branch).await);
    }

    /// Issue #656 regression lock: two sequential creates against the same repository never
    /// pick the same name, and neither call's own failure-cleanup (had it raced the other's
    /// name) ever removes artefacts the OTHER call owns.
    #[tokio::test]
    async fn two_sequential_creates_never_collide_and_both_keep_their_own_worktree() {
        let repo = init_repo().await;
        let first = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("first create");
        let second = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("second create");
        assert_ne!(first.branch, second.branch);
        assert_ne!(first.worktree_path, second.worktree_path);
        assert!(tokio::fs::metadata(&first.worktree_path).await.is_ok());
        assert!(tokio::fs::metadata(&second.worktree_path).await.is_ok());
        assert!(branch_exists(&repo, &first.branch).await);
        assert!(branch_exists(&repo, &second.branch).await);
    }

    #[tokio::test]
    async fn rejects_a_missing_base_branch_without_creating_anything() {
        let repo = init_repo().await;
        let err = add_worktree_with_generated_name(&repo, "does-not-exist")
            .await
            .expect_err("missing base branch must fail");
        assert_eq!(err.code, GitErrorCode::BaseMissing);
        let still_empty = tokio::fs::read_dir(worktrees_root(&repo)).await;
        if let Ok(mut entries) = still_empty {
            assert!(entries.next_entry().await.unwrap().is_none());
        }
        // No stray branch reservation survives a rejected attempt either.
        assert_eq!(list_branches(&repo).await.unwrap(), vec!["main".to_string()]);
    }

    /// Gate round 1, HIGH #656: a pre-existing folder (nothing to do with this attempt's own
    /// branch reservation) is detected via `AlreadyExists` and never touched -- not deleted,
    /// not descended into -- and the attempt's own branch reservation is cleaned up instead.
    #[tokio::test]
    async fn try_reserve_and_create_collision_on_a_pre_existing_folder_leaves_it_untouched() {
        let repo = init_repo().await;
        let candidate = "pre-existing-name";
        let path = worktrees_root(&repo).join(candidate);
        tokio::fs::create_dir_all(&path).await.unwrap();
        let marker = path.join("marker.txt");
        tokio::fs::write(&marker, b"do not touch").await.unwrap();

        let outcome = try_reserve_and_create(&repo, "main", candidate)
            .await
            .expect("a folder collision is not a hard error");
        assert!(matches!(outcome, CandidateOutcome::Collision));
        assert!(
            !branch_exists(&repo, candidate).await,
            "the reservation this attempt made must be cleaned up"
        );
        assert!(
            tokio::fs::metadata(&marker).await.is_ok(),
            "a folder this attempt never created must never be touched"
        );
    }

    /// Gate round 1, HIGH #656 regression lock: using the test-only candidate seam, force an
    /// attempt to collide on a name a real concurrent "winner" already fully created (branch +
    /// worktree + a file inside it), then fall back to a fresh name. The winner's branch,
    /// worktree and the file inside it must all survive untouched.
    #[tokio::test]
    async fn a_create_skips_a_colliding_candidate_and_never_touches_the_winners_artifacts() {
        let repo = init_repo().await;
        let winner = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create the 'winning' worktree");
        let marker = winner.worktree_path.join("marker.txt");
        tokio::fs::write(&marker, b"winner's file").await.unwrap();

        let fresh_name = format!("fresh-{}", uuid::Uuid::new_v4().simple());
        let candidates = vec![winner.branch.clone(), fresh_name];
        let ours = add_worktree_with_candidates(&repo, "main", candidates)
            .await
            .expect("falls back to the fresh candidate");

        assert_ne!(ours.branch, winner.branch);
        assert!(
            tokio::fs::metadata(&marker).await.is_ok(),
            "the winner's marker file must survive untouched"
        );
        assert!(
            branch_exists(&repo, &winner.branch).await,
            "the winner's branch must survive"
        );
        assert!(
            tokio::fs::metadata(&winner.worktree_path).await.is_ok(),
            "the winner's worktree must survive"
        );
    }


    #[test]
    fn is_branch_exists_error_recognises_gits_own_wording() {
        assert!(is_branch_exists_error(
            "fatal: a branch named 'foo' already exists"
        ));
        assert!(!is_branch_exists_error(
            "fatal: not a valid object name: 'bogus'"
        ));
    }

    #[test]
    fn map_add_worktree_error_recognises_base_missing_wording() {
        let err = map_add_worktree_error(
            "fatal: invalid reference: bogus",
            Path::new("C:/scratch/worktree"),
        );
        assert_eq!(err.code, GitErrorCode::BaseMissing);
    }

    #[test]
    fn map_add_worktree_error_recognises_path_too_long_wording() {
        let err = map_add_worktree_error(
            "fatal: unable to create file (file name too long)",
            Path::new("C:/scratch/worktree"),
        );
        assert_eq!(err.code, GitErrorCode::PathTooLong);
    }

    #[tokio::test]
    async fn recreate_worktree_reattaches_an_existing_branch_after_the_folder_is_removed() {
        let repo = init_repo().await;
        let added = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create worktree");
        remove_worktree(&repo, &added.worktree_path, &added.branch, false)
            .await
            .expect("remove worktree, keep branch");
        assert!(tokio::fs::metadata(&added.worktree_path).await.is_err());
        recreate_worktree(&repo, &added.worktree_path, &added.branch)
            .await
            .expect("recreate");
        assert!(tokio::fs::metadata(&added.worktree_path)
            .await
            .expect("recreated worktree exists")
            .is_dir());
    }
}
