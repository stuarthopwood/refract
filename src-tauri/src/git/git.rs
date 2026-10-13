// Port of `src/main/git/git.ts`: a shell-free `execFile` wrapper and the typed errors every
// git-backed module in `src-tauri/src/git` throws (contracts/omp-usage.md and tasks.md T011).

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

/// Windows-only: `CREATE_NO_WINDOW`, the same flag Node's `execFile({ windowsHide: true })` sets
/// under the hood -- no console window flashes for a `git`/`omp` child process. The whole build
/// is Windows-only (spec.md Assumptions), so this is applied unconditionally, the same way the
/// Job Object (`process::job_object`) and `windows` crate dependency already assume Windows.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorCode {
    NotARepo,
    NoCommits,
    GitFailed,
    WorktreeFailed,
    BaseMissing,
    PathTooLong,
    BranchMissing,
    CheckoutFailed,
}

impl GitErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotARepo => "not-a-repo",
            Self::NoCommits => "no-commits",
            Self::GitFailed => "git-failed",
            Self::WorktreeFailed => "worktree-failed",
            Self::BaseMissing => "base-missing",
            Self::PathTooLong => "path-too-long",
            Self::BranchMissing => "branch-missing",
            Self::CheckoutFailed => "checkout-failed",
        }
    }
}

#[derive(Debug)]
pub struct GitError {
    pub code: GitErrorCode,
    pub message: String,
}

impl GitError {
    pub fn new(code: GitErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GitError {}

/// An unexpected I/O error (for example `git` itself missing from PATH, or a spawn failure) maps
/// to the same `git-failed` code `git()`'s own non-zero-exit branch below uses -- matching
/// `ipc/util.ts`'s `mapStoreThrown` catch-all, which maps any error this module did not itself
/// construct as a typed `GitError` to that same fallback code.
impl From<io::Error> for GitError {
    fn from(err: io::Error) -> Self {
        Self::new(GitErrorCode::GitFailed, err.to_string())
    }
}

pub struct GitRawResult {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code; `0` on success. A spawn failure (e.g. git missing from PATH) is `1`.
    pub code: i32,
}

/// Environment variables that redirect git to a DIFFERENT repository than `cwd` says (set by an
/// unrelated tool, a shell profile, or a parent process) would otherwise let every caller of
/// `git_raw`/`git` operate on the wrong repository. Stripped for every invocation, matched
/// case-insensitively (Windows environment lookups are case-insensitive): `GIT_CEILING_
/// DIRECTORIES` is deliberately kept -- it only ever narrows git's own upward search, never
/// redirects it to an unrelated repository.
const GIT_ENV_VARS_TO_STRIP: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
];

fn is_stripped_env_var(key: &str) -> bool {
    GIT_ENV_VARS_TO_STRIP
        .iter()
        .any(|stripped| stripped.eq_ignore_ascii_case(key))
}

/// Runs `git <args>` with no shell in `cwd`. Never fails on a non-zero exit; callers branch on
/// `.code`. Resolves git's absolute path via `which` (security: Windows would otherwise search
/// `cwd` before PATH for a bare `"git"`, so a repository that commits its own `git.exe` could run
/// instead of the real one -- `which` only ever searches `PATH`, never the child's `cwd`).
pub async fn git_raw(cwd: &Path, args: &[&str], timeout: Option<Duration>) -> GitRawResult {
    let git_path = match which::which_global("git") {
        Ok(path) => path,
        Err(err) => {
            return GitRawResult {
                stdout: String::new(),
                stderr: err.to_string(),
                code: 1,
            }
        }
    };

    let mut command = Command::new(&git_path);
    command
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW);
    // Perf: a timed-out `output_future` below is dropped, not awaited to completion; without
    // this the child (and its pipes) would keep running as an orphan. `kill_on_drop` makes
    // tokio reap it the moment the future is dropped, matching Node's `execFile` timeout.
    command.kill_on_drop(true);
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        if let Some(key_str) = key.to_str() {
            if is_stripped_env_var(key_str) {
                continue;
            }
        }
        command.env(key, value);
    }

    let output_future = command.output();
    let result = match timeout {
        Some(duration) => match tokio::time::timeout(duration, output_future).await {
            Ok(result) => result,
            Err(_) => {
                return GitRawResult {
                    stdout: String::new(),
                    stderr: "git command timed out".to_string(),
                    code: 1,
                }
            }
        },
        None => output_future.await,
    };

    match result {
        Ok(output) => GitRawResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(1),
        },
        Err(err) => GitRawResult {
            stdout: String::new(),
            stderr: err.to_string(),
            code: 1,
        },
    }
}

/// Runs `git <args>` and returns trimmed stdout; fails with `GitError::GitFailed` on a non-zero
/// exit.
pub async fn git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let result = git_raw(cwd, args, None).await;
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
    Ok(result.stdout)
}

pub struct RepoInfo {
    /// Canonical absolute path of the main checkout (the repository's toplevel).
    pub path: String,
}

/// Validates that `repo_path` is a git repository with at least one commit, per T011:
/// `not-a-repo` when `rev-parse --show-toplevel` fails, `no-commits` when `rev-parse HEAD` fails.
pub async fn repo_info(repo_path: &Path) -> Result<RepoInfo, GitError> {
    let top = git_raw(repo_path, &["rev-parse", "--show-toplevel"], None).await;
    if top.code != 0 {
        return Err(GitError::new(
            GitErrorCode::NotARepo,
            format!("Not a git repository: {}", repo_path.display()),
        ));
    }
    let toplevel = normalize_git_path(top.stdout.trim());

    let head = git_raw(Path::new(&toplevel), &["rev-parse", "HEAD"], None).await;
    if head.code != 0 {
        return Err(GitError::new(
            GitErrorCode::NoCommits,
            format!("Repository has no commits: {}", repo_path.display()),
        ));
    }

    Ok(RepoInfo { path: toplevel })
}

/// Git for Windows prints toplevel paths with forward slashes; normalise to the platform
/// separator and uppercase drive letter so later comparisons only need `.to_lowercase()`.
pub fn normalize_git_path(p: &str) -> String {
    let with_platform_seps = p.replace('/', std::path::MAIN_SEPARATOR_STR);
    let bytes = with_platform_seps.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_lowercase() && bytes[1] == b':' {
        let mut upper = with_platform_seps.clone();
        upper.replace_range(0..1, &with_platform_seps[0..1].to_uppercase());
        upper
    } else {
        with_platform_seps
    }
}
