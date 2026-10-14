// Port of `src/main/github/gh.ts`: GitHub CLI (`gh`) access for pull request management
// (specs/003-pull-request-management), lane R9 issue #792. Mirrors `git/git.rs`'s `execFile`
// discipline: no shell, argument arrays only, an absolute resolved path (security: Windows would
// otherwise search `cwd` before PATH for a bare name). Every command shape and field name below
// is cited to research.md / docs/spike/FINDINGS.md rows 37 to 41 (live-probed against gh 2.102.0
// in the Electron build), except where noted as a reasonable, documented-gh-CLI addition beyond
// the literal probe set.
//
// Distinct from `github/pr_lookup.rs` (spec 004's read-only `pullRequestForBranch`, which keeps
// its own small `gh`/owner-repo plumbing rather than share this module's, matching the TS file
// layout this ports).

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::git::git::git_raw;

/// Windows-only: `CREATE_NO_WINDOW` (same flag `git_raw`/`OmpProcess` already apply) -- no
/// console window flashes for a `gh` child process.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhErrorCode {
    NoGithubRemote,
    GhUnavailable,
    RateLimited,
    GithubFailed,
    NotMergeable,
    GhNotFound,
    GhFailed,
    Timeout,
}

impl GhErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoGithubRemote => "no-github-remote",
            Self::GhUnavailable => "gh-unavailable",
            Self::RateLimited => "rate-limited",
            Self::GithubFailed => "github-failed",
            Self::NotMergeable => "not-mergeable",
            Self::GhNotFound => "gh-not-found",
            Self::GhFailed => "gh-failed",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Debug)]
pub struct GhError {
    pub code: GhErrorCode,
    pub message: String,
}

impl GhError {
    pub fn new(code: GhErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GhError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GhError {}

const TIMEOUT_MS: u64 = 15_000;

pub struct GhRawResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// `true` when the 15s timeout aborted the process -- distinguishes a hang from an ordinary
    /// non-zero exit.
    pub timed_out: bool,
}

/// Resolves `gh` on PATH, honouring `PATHEXT`, caching the first successful resolution for the
/// process lifetime (same rationale as `process::executables::resolve_omp`).
fn resolve_gh() -> Result<std::path::PathBuf, ()> {
    static CACHE: std::sync::LazyLock<Result<std::path::PathBuf, ()>> =
        std::sync::LazyLock::new(|| which::which_global("gh").map_err(|_| ()));
    CACHE.clone()
}

/// Runs `gh <args>` with no shell in `cwd`. Never fails on a non-zero exit; callers branch on
/// `.code`/`.timed_out`. Fails only when `gh` itself cannot be found on PATH --
/// `not_found_code` lets `cli.rs`'s account commands keep their own `gh-not-found` vocabulary
/// while sharing this one timed/resolved runner; every pull-request call site below passes
/// `None` and keeps today's `gh-unavailable` behaviour.
pub async fn gh_raw(
    cwd: &Path,
    args: &[&str],
    not_found_code: Option<GhErrorCode>,
) -> Result<GhRawResult, GhError> {
    let gh_path = resolve_gh().map_err(|_| {
        GhError::new(
            not_found_code.unwrap_or(GhErrorCode::GhUnavailable),
            "The GitHub CLI (gh) is not installed or not on PATH.",
        )
    })?;

    let mut command = tokio::process::Command::new(&gh_path);
    command
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW);
    command.kill_on_drop(true);

    let output_future = command.output();
    match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), output_future).await {
        Ok(Ok(output)) => Ok(GhRawResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(1),
            timed_out: false,
        }),
        Ok(Err(err)) => Ok(GhRawResult {
            stdout: String::new(),
            stderr: err.to_string(),
            code: 1,
            timed_out: false,
        }),
        Err(_) => Ok(GhRawResult {
            stdout: String::new(),
            stderr: String::new(),
            code: 1,
            timed_out: true,
        }),
    }
}

/// Research.md "Polling interval and rate-limit headroom": the rate-limited signal is `gh`'s own
/// `HTTPError.Error()` format ("HTTP 403/429: <GitHub message> (<url>)"), sourced from cli/go-gh's
/// published error formatting, not reproduced live (forbidden -- real shared-account quota risk).
/// `gh-unavailable` covers not-signed-in and offline.
pub(super) fn map_gh_failure(stderr: &str, stdout: &str) -> GhError {
    let text = format!("{stderr}\n{stdout}").to_lowercase();
    if text.contains("rate limit") {
        return GhError::new(
            GhErrorCode::RateLimited,
            non_empty_or(stderr, stdout, "GitHub rate limit exceeded."),
        );
    }
    let unavailable = text.contains("gh auth login")
        || text.contains("not logged into")
        || text.contains("authentication required")
        || text.contains("could not resolve")
        || text.contains("enotfound")
        || text.contains("getaddrinfo")
        || text.contains("network is unreachable");
    if unavailable {
        return GhError::new(
            GhErrorCode::GhUnavailable,
            non_empty_or(
                stderr,
                stdout,
                "GitHub CLI is not signed in or GitHub is unreachable.",
            ),
        );
    }
    GhError::new(
        GhErrorCode::GithubFailed,
        non_empty_or(stderr, stdout, "gh command failed."),
    )
}

pub(super) fn non_empty_or(stderr: &str, stdout: &str, fallback: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    fallback.to_string()
}

pub async fn gh_json<T: serde::de::DeserializeOwned>(
    cwd: &Path,
    args: &[&str],
) -> Result<T, GhError> {
    let result = gh_raw(cwd, args, None).await?;
    if result.code != 0 {
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    serde_json::from_str(&result.stdout).map_err(|_| {
        GhError::new(
            GhErrorCode::GithubFailed,
            format!("gh returned invalid JSON for: gh {}", args.join(" ")),
        )
    })
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

/// `gh api graphql -f query=<query> [-f k=v | -F k=v]...`. Variables are passed as `-f`/`-F`
/// fields, never interpolated into the query string, so no caller-supplied text (a comment body,
/// a thread id) can ever need hand-escaping or risk breaking/injecting into the query.
pub async fn gh_graphql<T: serde::de::DeserializeOwned>(
    cwd: &Path,
    query: &str,
    variables: &[(&str, GraphqlValue<'_>)],
) -> Result<T, GhError> {
    let mut owned_args: Vec<String> = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
    ];
    for (key, value) in variables {
        match value {
            GraphqlValue::Str(v) => {
                owned_args.push("-f".to_string());
                owned_args.push(format!("{key}={v}"));
            }
            GraphqlValue::Int(v) => {
                owned_args.push("-F".to_string());
                owned_args.push(format!("{key}={v}"));
            }
        }
    }
    let args: Vec<&str> = owned_args.iter().map(String::as_str).collect();
    let result = gh_raw(cwd, &args, None).await?;
    if result.code != 0 {
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    let parsed: GraphqlResponse<T> = serde_json::from_str(&result.stdout)
        .map_err(|_| GhError::new(GhErrorCode::GithubFailed, "gh api graphql returned invalid JSON."))?;
    if let Some(errors) = &parsed.errors {
        if !errors.is_empty() {
            let joined = errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(GhError::new(GhErrorCode::GithubFailed, joined));
        }
    }
    parsed
        .data
        .ok_or_else(|| GhError::new(GhErrorCode::GithubFailed, "gh api graphql returned no data."))
}

pub enum GraphqlValue<'a> {
    Str(&'a str),
    Int(i64),
}

/// `owner/repo`, inferred from the repository's `origin` remote URL. Handles both the HTTPS
/// (`https://github.com/<owner>/<repo>.git`) and SSH (`git@github.com:<owner>/<repo>.git`)
/// forms; `.git` suffix and any trailing slash are stripped.
pub async fn owner_repo_for(repo_path: &Path) -> Result<(String, String), GhError> {
    let remote = git_raw(repo_path, &["remote", "get-url", "origin"], None).await;
    if remote.code != 0 {
        return Err(GhError::new(
            GhErrorCode::NoGithubRemote,
            "This repository has no \"origin\" remote.",
        ));
    }
    parse_owner_repo(remote.stdout.trim()).ok_or_else(|| {
        GhError::new(
            GhErrorCode::NoGithubRemote,
            "This repository's origin remote is not a github.com remote.",
        )
    })
}

/// Parses `owner/repo` out of a `github.com` HTTPS or SSH remote URL, case-insensitively on the
/// host, anchored (no extra path segments, query string, or fragment) the same way the ported
/// TS regexes were.
fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    if let Ok(url) = tauri::Url::parse(remote_url) {
        let scheme_ok = url.scheme().eq_ignore_ascii_case("https") || url.scheme().eq_ignore_ascii_case("http");
        let host_ok = url
            .host_str()
            .map(|h| h.eq_ignore_ascii_case("github.com"))
            .unwrap_or(false);
        if scheme_ok
            && host_ok
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
        {
            let segments: Vec<&str> = url
                .path()
                .trim_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
                .collect();
            if segments.len() == 2 {
                let owner = segments[0];
                let repo = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
                if !owner.is_empty() && !repo.is_empty() {
                    return Some((owner.to_string(), repo.to_string()));
                }
            }
        }
        return None;
    }
    const SSH_PREFIX: &str = "git@github.com:";
    if remote_url.len() > SSH_PREFIX.len() && remote_url[..SSH_PREFIX.len()].eq_ignore_ascii_case(SSH_PREFIX) {
        let rest = remote_url[SSH_PREFIX.len()..].trim_end_matches('/');
        let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if segments.len() == 2 {
            let owner = segments[0];
            let repo = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
            if !owner.is_empty() && !repo.is_empty() {
                return Some((owner.to_string(), repo.to_string()));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Shared wire primitives (used by `gh_pull_requests.rs` and `gh_mutations.rs` alike)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct GhActor {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhLabel {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhCheckRun {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

