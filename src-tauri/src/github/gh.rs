// `gh` access for pull request management: no shell, argument arrays, and an absolute resolved
// path (Windows would otherwise search `cwd` before PATH).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::Duration;

use serde::Deserialize;

use crate::git::git::git_raw;

/// Windows-only: `CREATE_NO_WINDOW` so no console flashes for the `gh` child.
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

pub(super) const TIMEOUT_MS: u64 = 15_000;

pub struct GhRawResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// `true` when the 15s timeout aborted the process (a hang, not a non-zero exit).
    pub timed_out: bool,
}

/// Resolves `gh`: the portable install is rechecked every call (no relaunch needed); the `PATH`
/// fallback is cached. Shared with `updates::gh_client` (#829).
pub(crate) fn resolve_gh() -> Result<std::path::PathBuf, ()> {
    if let Some(dir) = dirs::data_local_dir() {
        let candidate = dir.join("refract").join("tools").join("gh").join("gh.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    static CACHE: std::sync::LazyLock<Result<std::path::PathBuf, ()>> =
        std::sync::LazyLock::new(|| which::which_global("gh").map_err(|_| ()));
    CACHE.clone()
}

/// Runs `gh <args>` with no shell in `cwd`; fails only when `gh` is not found.
/// `not_found_code` and `timeout` are overridable for `cli.rs` and `updates::gh_client` (#829).
pub async fn gh_raw(
    cwd: &Path,
    args: &[&str],
    not_found_code: Option<GhErrorCode>,
    timeout: Duration,
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
    match tokio::time::timeout(timeout, output_future).await {
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

/// Rate-limit detection keys off `gh`'s `HTTPError` format ("HTTP 403/429: ..."), not reproduced
/// live to spare shared quota. `gh-unavailable` covers not-signed-in and offline.
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

/// Returned strings reach the renderer and logs, and `gh` stderr can echo a pasted credential, so
/// they are redacted here; the fixed `fallback` needs none.
pub(crate) fn non_empty_or(stderr: &str, stdout: &str, fallback: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return crate::omp::redact::redact_secrets(stderr);
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return crate::omp::redact::redact_secrets(stdout);
    }
    fallback.to_string()
}

pub async fn gh_json<T: serde::de::DeserializeOwned>(
    cwd: &Path,
    args: &[&str],
) -> Result<T, GhError> {
    let result = gh_raw(cwd, args, None, Duration::from_millis(TIMEOUT_MS)).await?;
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

/// `gh api graphql -f query=<query> [-f k=v | -F k=v]...`. Variables are `-f`/`-F` fields, never
/// interpolated into the query, so caller text cannot inject into it.
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
    let result = gh_raw(cwd, &args, None, Duration::from_millis(TIMEOUT_MS)).await?;
    if result.code != 0 {
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    let parsed: GraphqlResponse<T> = serde_json::from_str(&result.stdout).map_err(|_| {
        GhError::new(
            GhErrorCode::GithubFailed,
            "gh api graphql returned invalid JSON.",
        )
    })?;
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
    parsed.data.ok_or_else(|| {
        GhError::new(
            GhErrorCode::GithubFailed,
            "gh api graphql returned no data.",
        )
    })
}

pub enum GraphqlValue<'a> {
    Str(&'a str),
    Int(i64),
}

/// `owner/repo` from the `origin` remote (HTTPS or SSH, `.git` and trailing slash stripped).
/// Cached per `repo_path`; a mid-session remote change is not seen until restart.
pub async fn owner_repo_for(repo_path: &Path) -> Result<(String, String), GhError> {
    static CACHE: LazyLock<StdMutex<HashMap<PathBuf, (String, String)>>> =
        LazyLock::new(|| StdMutex::new(HashMap::new()));
    if let Some(cached) = CACHE
        .lock()
        .expect("owner/repo cache mutex poisoned")
        .get(repo_path)
    {
        return Ok(cached.clone());
    }
    let remote = git_raw(repo_path, &["remote", "get-url", "origin"], None).await;
    if remote.code != 0 {
        return Err(GhError::new(
            GhErrorCode::NoGithubRemote,
            "This project has no \"origin\" remote.",
        ));
    }
    let owner_repo = parse_owner_repo(remote.stdout.trim()).ok_or_else(|| {
        GhError::new(
            GhErrorCode::NoGithubRemote,
            "This project's origin remote is not a github.com remote.",
        )
    })?;
    CACHE
        .lock()
        .expect("owner/repo cache mutex poisoned")
        .insert(repo_path.to_path_buf(), owner_repo.clone());
    Ok(owner_repo)
}

/// Segments may only hold GitHub's owner/name characters (`[A-Za-z0-9._-]`); `.`/`..` are rejected
/// to avoid a traversal-shaped `gh api repos/../x` argument (defence in depth).
pub(super) fn is_valid_owner_or_repo_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Parses `owner/repo` from a `github.com` HTTPS or SSH remote URL; host is case-insensitive and
/// extra path segments, query or fragment are refused.
fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    if let Ok(url) = tauri::Url::parse(remote_url) {
        let scheme_ok =
            url.scheme().eq_ignore_ascii_case("https") || url.scheme().eq_ignore_ascii_case("http");
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
                if is_valid_owner_or_repo_segment(owner) && is_valid_owner_or_repo_segment(repo) {
                    return Some((owner.to_string(), repo.to_string()));
                }
            }
        }
        return None;
    }
    const SSH_PREFIX: &str = "git@github.com:";
    // `.get(..)`, not indexing: non-ASCII text at byte 15 would panic mid-character.
    let prefix = remote_url.get(..SSH_PREFIX.len())?;
    if prefix.eq_ignore_ascii_case(SSH_PREFIX) {
        let rest = remote_url[SSH_PREFIX.len()..].trim_end_matches('/');
        let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if segments.len() == 2 {
            let owner = segments[0];
            let repo = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
            if is_valid_owner_or_repo_segment(owner) && is_valid_owner_or_repo_segment(repo) {
                return Some((owner.to_string(), repo.to_string()));
            }
        }
    }
    None
}

/// `login` is absent for a Team actor (`__typename: "Team"`); `map_actor` falls back to `'unknown'`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GhActor {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// GraphQL actors send `__typename` (`Bot` for an app); `gh`'s porcelain authors send
    /// `is_bot` instead. Either marks the actor as a bot.
    #[serde(default, rename = "__typename")]
    pub typename: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default, rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhLabel {
    pub name: String,
}

/// A `statusCheckRollup` entry: a `CheckRun` (`name`/`status`/`conclusion`/`detailsUrl`) or a
/// `StatusContext` (`context`/`state`/`targetUrl`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCheckRun {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub details_url: Option<String>,
    #[serde(default)]
    pub target_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_with_git_suffix() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parses_https_without_git_suffix_and_trailing_slash() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo/"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parses_ssh_form() {
        assert_eq!(
            parse_owner_repo("git@github.com:owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parses_mixed_case_host() {
        assert_eq!(
            parse_owner_repo("https://GitHub.COM/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn rejects_non_github_https_host() {
        assert_eq!(parse_owner_repo("https://gitlab.com/owner/repo.git"), None);
    }

    #[test]
    fn rejects_ssh_to_wrong_host() {
        assert_eq!(parse_owner_repo("git@gitlab.com:owner/repo.git"), None);
    }

    #[test]
    fn rejects_query_string() {
        assert_eq!(parse_owner_repo("https://github.com/owner/repo?x=1"), None);
    }

    #[test]
    fn rejects_garbage_string() {
        assert_eq!(parse_owner_repo("not a url at all"), None);
    }

    #[test]
    fn rejects_dot_and_dotdot_owner_or_repo_segments() {
        assert_eq!(parse_owner_repo("https://github.com/owner/.."), None);
        assert_eq!(parse_owner_repo("https://github.com/../repo"), None);
        assert_eq!(parse_owner_repo("git@github.com:owner/.."), None);
    }

    #[test]
    fn rejects_disallowed_characters_in_owner_or_repo() {
        assert_eq!(parse_owner_repo("https://github.com/own er/repo"), None);
        assert_eq!(parse_owner_repo("https://github.com/owner/re/po"), None);
    }

    #[test]
    fn ssh_prefix_check_never_panics_on_non_ascii_boundary() {
        // Byte 15 falls inside this multi-byte character; `.get(..)` must return `None`.
        assert_eq!(parse_owner_repo("git@github.co\u{1F600}wner/repo"), None);
    }

    #[test]
    fn maps_rate_limit() {
        let err = map_gh_failure("API rate limit exceeded for user", "");
        assert_eq!(err.code, GhErrorCode::RateLimited);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn maps_not_signed_in() {
        let err = map_gh_failure(
            "To get started with GitHub CLI, please run: gh auth login",
            "",
        );
        assert_eq!(err.code, GhErrorCode::GhUnavailable);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn maps_network_unreachable() {
        let err = map_gh_failure("dial tcp: network is unreachable", "");
        assert_eq!(err.code, GhErrorCode::GhUnavailable);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn maps_other_failure_to_github_failed() {
        let err = map_gh_failure("some unexpected gh error", "");
        assert_eq!(err.code, GhErrorCode::GithubFailed);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn non_empty_or_falls_back_in_order() {
        assert_eq!(non_empty_or("  err  ", "out", "fallback"), "err");
        assert_eq!(non_empty_or("   ", "out", "fallback"), "out");
        assert_eq!(non_empty_or("   ", "   ", "fallback"), "fallback");
    }

    #[test]
    fn map_gh_failure_redacts_a_github_token_found_in_stderr() {
        // Split into fragments so no source literal reads as a live credential.
        let token = format!("{}{}", "ghp_", "1234567890abcdef");
        let stderr = format!("some unexpected gh error: {token}");
        let err = map_gh_failure(&stderr, "");
        assert_eq!(err.code, GhErrorCode::GithubFailed);
        assert!(!err.message.contains(&token));
    }
}
