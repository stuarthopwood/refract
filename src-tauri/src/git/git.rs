//! Shell-free git `execFile` wrapper and typed git errors.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use tokio::process::Command;

/// Windows-only build, so `CREATE_NO_WINDOW` is applied unconditionally to stop console flashes.
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
    /// An external process still holds the worktree folder (#891).
    WorktreeHeld,
    /// Refract's own per-Session worktree lock stayed busy past its bound (#1163); retry works.
    WorktreeBusy,
    /// A pathspec failed containment validation before reaching git; shares the
    /// `outside-worktree` wire code with the File explorer.
    OutsideWorktree,
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
            Self::WorktreeHeld => "worktree-held",
            Self::WorktreeBusy => "worktree-busy",
            Self::OutsideWorktree => "outside-worktree",
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

/// Unexpected I/O errors (e.g. git missing from PATH) map to the `git-failed` fallback code.
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

/// Env vars that would redirect git to a different repository than `cwd`; stripped
/// case-insensitively. `GIT_CEILING_DIRECTORIES` is kept: it only narrows the upward search.
const GIT_ENV_VARS_TO_STRIP: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    // Defence in depth alongside `--no-ext-diff`: never honour a user's external diff driver.
    "GIT_EXTERNAL_DIFF",
];

fn is_stripped_env_var(key: &str) -> bool {
    GIT_ENV_VARS_TO_STRIP
        .iter()
        .any(|stripped| stripped.eq_ignore_ascii_case(key))
}

// Resolved once via `which` (PATH only): a bare "git" on Windows searches `cwd` first, so a
// repo-committed `git.exe` could otherwise run. Cached, failure included.
static GIT_PATH: LazyLock<Result<PathBuf, String>> =
    LazyLock::new(|| which::which_global("git").map_err(|err| err.to_string()));

/// Builds a `git <args>` `Command` for `cwd`; the one place security setup lives. `Err` when
/// git's path could not be resolved.
fn build_git_command(cwd: &Path, args: &[&str]) -> Result<Command, GitRawResult> {
    let git_path = match GIT_PATH.as_ref() {
        Ok(path) => path,
        Err(err) => {
            return Err(GitRawResult {
                stdout: String::new(),
                stderr: err.clone(),
                code: 1,
            })
        }
    };

    let mut command = Command::new(git_path);
    command
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW);
    // A timed-out future is dropped; kill_on_drop stops the child orphaning.
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
    Ok(command)
}

/// Runs `git <args>` with no shell in `cwd`. Never fails on a non-zero exit; callers branch on
/// `.code`.
pub async fn git_raw(cwd: &Path, args: &[&str], timeout: Option<Duration>) -> GitRawResult {
    let mut command = match build_git_command(cwd, args) {
        Ok(command) => command,
        Err(result) => return result,
    };

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

/// Runs `git <args>` with `stdin_data` piped and closed. Stdin avoids argv length and quoting
/// limits for `git commit -F -`. Never fails on non-zero exit; branch on `.code`.
pub async fn git_raw_with_stdin(
    cwd: &Path,
    args: &[&str],
    stdin_data: &[u8],
    timeout: Option<Duration>,
) -> GitRawResult {
    let mut command = match build_git_command(cwd, args) {
        Ok(command) => command,
        Err(result) => return result,
    };
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return GitRawResult {
                stdout: String::new(),
                stderr: err.to_string(),
                code: 1,
            }
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        if let Err(err) = stdin.write_all(stdin_data).await {
            return GitRawResult {
                stdout: String::new(),
                stderr: err.to_string(),
                code: 1,
            };
        }
        // Close stdin (EOF) before awaiting output; `git commit -F -` reads to EOF.
        drop(stdin);
    }

    let output_future = child.wait_with_output();
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

/// Runs `git <args>` and returns stdout; `GitError::GitFailed` on non-zero exit.
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

/// Validates `repo_path` is a git repo with a commit (`not-a-repo` / `no-commits` otherwise).
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
            format!("This folder has no commits yet: {}", repo_path.display()),
        ));
    }

    Ok(RepoInfo { path: toplevel })
}

/// Normalises git's forward-slash paths and uppercases the drive letter for `.to_lowercase()`
/// comparisons.
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

/// A path for a user-facing message: `.`/`..` collapsed lexically (a Session worktree lives at
/// `<repo>/../pinion-worktrees/...`, so the raw path always carries a `..`), then `normalize_git_path`.
/// Display only; never use the result to touch the filesystem.
pub fn shown_path(path: &Path) -> String {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    normalize_git_path(&out.to_string_lossy())
}
