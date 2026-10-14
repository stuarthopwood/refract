// Port of `src/main/git/worktrees.ts`: worktree lifecycle for a Session (data-model.md
// `Session.worktreePath`/`branch`, tasks.md T011, T016). One Session = one git worktree, created
// under `<repo>/../pinion-worktrees/<repoName>/<name>`. Only the slice this build's milestone 1
// needs is ported: repository-validity support (`repo_info` in `git.rs`), the branch-listing CLI
// wrapper `repositories.branches` uses, and the worktree-create path `sessions.create` uses --
// not the full Electron file's delete/recreate/pull-request helpers, which no milestone-1
// channel in this build calls.

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

/// Picks a readable adjective-noun name (e.g. "swift-otter"), unique against the repository's
/// local branches and the folders already under its worktrees root.
pub async fn generate_name(repo: &Path) -> Result<String, GitError> {
    let branches: std::collections::HashSet<String> =
        list_branches(repo).await?.into_iter().collect();

    let mut existing_folders = std::collections::HashSet::new();
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

    let attempts = ADJECTIVES.len() * NOUNS.len();
    for _ in 0..attempts {
        let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
        let noun = NOUNS[random_index(NOUNS.len())];
        let candidate = format!("{adjective}-{noun}");
        if !branches.contains(&candidate) && !existing_folders.contains(&candidate) {
            return Ok(candidate);
        }
    }

    // All 1,600 combinations are taken (practically unreachable): disambiguate with a short
    // suffix (the Rust equivalent of the TS `randomBytes(2).toString('hex')`, via `uuid` -- the
    // only randomness source already in this crate's dependencies).
    let adjective = ADJECTIVES[random_index(ADJECTIVES.len())];
    let noun = NOUNS[random_index(NOUNS.len())];
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    Ok(format!("{adjective}-{noun}-{}", &suffix[0..4]))
}

pub struct AddWorktreeResult {
    pub worktree_path: PathBuf,
    pub branch: String,
}

/// Creates `<repo>/../pinion-worktrees/<repoName>/<name>` with a new branch `name` off
/// `base_branch`. On any failure, removes the worktree and branch it created (no half-created
/// Session) and fails with a `GitError` mapped to `base-missing`, `path-too-long`, or
/// `worktree-failed`.
pub async fn add_worktree(
    repo: &Path,
    name: &str,
    base_branch: &str,
) -> Result<AddWorktreeResult, GitError> {
    let worktree_path = worktrees_root(repo).join(name);

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
        &[
            "worktree",
            "add",
            "-b",
            name,
            "--",
            &worktree_path_str,
            base_branch,
        ],
        None,
    )
    .await;
    if result.code != 0 {
        cleanup_failed_worktree(repo, name, &worktree_path).await;
        return Err(map_add_worktree_error(&result.stderr, &worktree_path));
    }

    Ok(AddWorktreeResult {
        worktree_path,
        branch: name.to_string(),
    })
}

async fn cleanup_failed_worktree(repo: &Path, name: &str, worktree_path: &Path) {
    let worktree_path_str = worktree_path.to_string_lossy().into_owned();
    git_raw(
        repo,
        &["worktree", "remove", "--force", "--", &worktree_path_str],
        None,
    )
    .await;
    // Best effort: leave the directory behind rather than mask the original git failure.
    let _ = tokio::fs::remove_dir_all(worktree_path).await;
    git_raw(repo, &["worktree", "prune"], None).await;
    git_raw(repo, &["branch", "-D", "--", name], None).await;
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
/// `add_worktree` already succeeded (a Repository removed mid-flight, the same race
/// `RegistryStore::add_session`'s own doc comment describes).
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

/// Port of `worktrees.ts`'s own `uniquePullRequestBranchName` (lane R9, issue #792): picks a
/// free local name for pull request `number`'s worktree/branch, starting at `pr-<number>` and
/// falling back to `pr-<number>-2`, `pr-<number>-3`, ... up to 1000 attempts -- an earlier
/// Session for the same pull request, or a failed prior attempt that left a branch or folder
/// behind, must never collide with a fresh `newSessionFromPullRequest` call.
pub async fn unique_pull_request_branch_name(repo: &Path, number: u64) -> Result<String, GitError> {
    let base = format!("pr-{number}");
    let branches: std::collections::HashSet<String> =
        list_branches(repo).await?.into_iter().collect();

    let mut existing_folders = std::collections::HashSet::new();
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

    if !branches.contains(&base) && !existing_folders.contains(&base) {
        return Ok(base);
    }
    const MAX_ATTEMPTS: u32 = 1000;
    for suffix in 2..=MAX_ATTEMPTS {
        let candidate = format!("{base}-{suffix}");
        if !branches.contains(&candidate) && !existing_folders.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(GitError::new(
        GitErrorCode::WorktreeFailed,
        format!(
            "Could not find a free local name for pull request #{number}'s worktree: every \"{base}\"/\"{base}-2\"..\"{base}-{MAX_ATTEMPTS}\" is already taken."
        ),
    ))
}

/// Port of `worktrees.ts`'s own `addWorktreeFromPullRequestBranch` (lane R9, issue #792):
/// `git fetch origin pull/<number>/head:<local_branch_name>` (works for both same-repository and
/// fork pull requests), then attaches a new worktree to that fetched branch (no `-b`: the branch
/// already exists after the fetch). On any failed step after the fetch succeeds, removes
/// whatever this attempt already created (branch and/or worktree directory) -- the same
/// all-or-nothing contract `add_worktree` keeps. `local_branch_name` MUST already be
/// collision-checked by the caller (`unique_pull_request_branch_name` above); this function's
/// own cleanup-on-failure is only safe for a name this exact attempt created.
pub async fn add_worktree_from_pull_request_branch(
    repo: &Path,
    number: u64,
    local_branch_name: &str,
) -> Result<AddWorktreeResult, GitError> {
    let fetch_result = git_raw(
        repo,
        &[
            "fetch",
            "origin",
            &format!("pull/{number}/head:{local_branch_name}"),
        ],
        None,
    )
    .await;
    if fetch_result.code != 0 {
        // Nothing was created yet (the fetch itself failed): no cleanup needed.
        return Err(GitError::new(
            GitErrorCode::CheckoutFailed,
            if fetch_result.stderr.trim().is_empty() {
                format!("Could not fetch pull request #{number}'s head branch.")
            } else {
                crate::omp::redact::redact_secrets(fetch_result.stderr.trim())
            },
        ));
    }

    let worktree_path = worktrees_root(repo).join(local_branch_name);
    if let Some(parent) = worktree_path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            git_raw(repo, &["branch", "-D", "--", local_branch_name], None).await;
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
    let add_result = git_raw(
        repo,
        &[
            "worktree",
            "add",
            "--",
            &worktree_path_str,
            local_branch_name,
        ],
        None,
    )
    .await;
    if add_result.code != 0 {
        cleanup_failed_worktree(repo, local_branch_name, &worktree_path).await;
        return Err(map_add_worktree_error(&add_result.stderr, &worktree_path));
    }

    Ok(AddWorktreeResult {
        worktree_path,
        branch: local_branch_name.to_string(),
    })
}
