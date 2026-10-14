// Minimal, independent `gh` CLI wrapper for `updates::checker` (lane R11b, issue #794). Deliberately
// NOT a port of `src/main/github/gh.ts` in full -- that file's PR-management surface
// (ghGraphql/ownerRepoFor/search/the GhErrorCode-typed GhError, ...) belongs to spec 003/004, not
// this spec's update-availability check. Only the `githubCliStatus`/`timeoutMs` diff that
// `origin/spec-006-impl` added on top of `origin/main`'s `gh.ts` is ported here. Deliberately
// independent of `src-tauri/src/github/` (that tree is pre-declared for a different, still
// in-flight lane) -- this module has no dependency on it and must not gain one.
//
// `git::git`'s shell-free `tokio::process::Command` wrapper pattern (no shell, `CREATE_NO_WINDOW`
// on Windows, `kill_on_drop(true)`, a bounded `tokio::time::timeout`) is reused here rather than
// re-derived; the absolute-path-via-`which` reasoning in that module's own `GIT_PATH` doc comment
// applies identically to `gh`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use tokio::process::Command;

/// Windows-only: no console window flashes for a `gh` child process (same flag as `git::git`'s
/// own `CREATE_NO_WINDOW`; Node's `execFile({ windowsHide: true })` sets this under the hood).
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `gh <args>` invocation's raw result. Never constructed for a "gh not found on PATH"
/// failure -- that case is a `Result::Err(String)` from `gh_raw`/`gh_json` instead.
pub struct GhRawResult {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code; `0` on success. A spawn error or a timed-out process is `1`.
    pub code: i32,
}

/// Port of `gh.ts`'s `GithubCliStatus` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubCliStatus {
    Ok,
    NotInstalled,
    NotSignedIn,
    Offline,
}

const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// Longest actionable error message surfaced from a `gh` failure; `gh`'s own error text can
/// include a full HTTP response body, which is neither actionable nor safe to persist/log in
/// full.
const MAX_ERROR_LEN: usize = 500;

/// Resolves `gh` on PATH via `which` (security: Windows' `CreateProcess` searches `cwd` before
/// `PATH` for a bare name, so a worktree that happened to contain e.g. `gh.exe` at its root could
/// otherwise run instead of the real one). Deliberately NOT cached like
/// `process::executables::resolve_omp`'s `OMP_CACHE`: every call through this module is
/// infrequent (an update check on startup, an occasional user-initiated retry), so re-resolving
/// on PATH each time is cheap and always correct -- unlike a process-lifetime cache, it never
/// goes stale after the developer installs `gh` mid-session and retries without relaunching
/// Refract.
pub fn resolve_gh() -> Result<PathBuf, String> {
    which::which_global("gh").map_err(|err| err.to_string())
}

/// Runs `gh <args>` with no shell in `cwd`, bounded by `timeout`. Never fails for an ordinary
/// non-zero exit (a rate limit, an unauthenticated call, ...); callers branch on `.code`. Only
/// fails, returning `Err`, when `gh` itself cannot be resolved on PATH at all (`resolve_gh`'s own
/// failure) -- a timeout or a spawn error both still produce an `Ok(GhRawResult)` with a
/// synthesised non-zero `code` instead, so every caller has exactly one place (`.code`) to branch
/// on for "did the command itself succeed".
pub async fn gh_raw(cwd: &Path, args: &[&str], timeout: Duration) -> Result<GhRawResult, String> {
    let gh_path = resolve_gh()?;

    let mut command = Command::new(&gh_path);
    command
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);

    let output = match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            return Ok(GhRawResult {
                stdout: String::new(),
                stderr: err.to_string(),
                code: 1,
            })
        }
        Err(_) => {
            return Ok(GhRawResult {
                stdout: String::new(),
                stderr: "gh command timed out".to_string(),
                code: 1,
            })
        }
    };

    Ok(GhRawResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(1),
    })
}

/// Trims, picks the non-empty one of stderr/stdout (stderr preferred, matching `gh.ts`'s own
/// `mapGhFailure`), and caps the result so a `gh`-reported failure never persists or logs an
/// unbounded blob.
fn capped_failure_text(stderr: &str, stdout: &str, args_joined: &str) -> String {
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    let text = if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        format!("gh command failed: gh {args_joined}")
    };
    if text.chars().count() > MAX_ERROR_LEN {
        let truncated: String = text.chars().take(MAX_ERROR_LEN).collect();
        format!("{truncated}…")
    } else {
        text
    }
}

/// `gh_raw` plus a `serde_json` parse of stdout on a zero exit. A non-zero exit or invalid JSON
/// is an `Err` with an actionable, trimmed, capped message (never a raw, unbounded stderr dump).
pub async fn gh_json<T: DeserializeOwned>(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<T, String> {
    let args_joined = args.join(" ");
    let result = gh_raw(cwd, args, timeout).await?;
    if result.code != 0 {
        return Err(capped_failure_text(
            &result.stderr,
            &result.stdout,
            &args_joined,
        ));
    }
    serde_json::from_str(&result.stdout)
        .map_err(|_| format!("gh returned invalid JSON for: gh {args_joined}"))
}

/// `could not resolve host|enotfound|getaddrinfo|network is unreachable|timed? ?out|
/// econnrefused|econnreset`, case-insensitive (`gh.ts`'s `OFFLINE_RE`), hand-matched since this
/// build has no regex crate dependency. `timed? ?out` expands to its four literal combinations
/// (optional `d`, optional space before `out`): `timeout`, `timedout`, `time out`, `timed out`.
fn looks_offline(text: &str) -> bool {
    let lower = text.to_lowercase();
    const SUBSTRINGS: &[&str] = &[
        "could not resolve host",
        "enotfound",
        "getaddrinfo",
        "network is unreachable",
        "econnrefused",
        "econnreset",
        "timeout",
        "timedout",
        "time out",
        "timed out",
    ];
    SUBSTRINGS.iter().any(|needle| lower.contains(needle))
}

/// Spec 006 shared "is gh signed in" check (port of `gh.ts`'s `githubCliStatus`, used by
/// `updates::checker::check_for_updates`). Never panics. An `Err` from `gh_raw` -- meaning `gh`
/// itself could not be resolved on PATH -- maps to `NotInstalled`; `gh_raw` never fails for a
/// network/auth failure, only for a missing `gh` (those surface as a non-zero `.code` instead).
pub async fn github_cli_status(cwd: &Path) -> GithubCliStatus {
    let auth = match gh_raw(cwd, &["auth", "status"], AUTH_STATUS_TIMEOUT).await {
        Ok(result) => result,
        Err(_) => return GithubCliStatus::NotInstalled,
    };
    if auth.code == 0 {
        return GithubCliStatus::Ok;
    }
    if looks_offline(&format!("{}\n{}", auth.stdout, auth.stderr)) {
        return GithubCliStatus::Offline;
    }
    GithubCliStatus::NotSignedIn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_patterns_match_representative_gh_stderr() {
        let matching = [
            "could not resolve host: api.github.com",
            "dial tcp: lookup api.github.com: no such host: ENOTFOUND",
            "dial tcp: lookup api.github.com: getaddrinfo ENOTFOUND",
            "dial tcp: i/o timeout",
            "dial tcp: connection timed out",
            "read tcp: connection reset by peer (ECONNRESET)",
            "connect: connection refused (ECONNREFUSED)",
            "network is unreachable",
            "SOME ERROR: Could Not Resolve Host (mixed case)",
        ];
        for text in matching {
            assert!(looks_offline(text), "expected offline match for: {text}");
        }
    }

    #[test]
    fn offline_patterns_do_not_match_ordinary_gh_failures() {
        let non_matching = [
            "You are not logged into any GitHub hosts.",
            "HTTP 404: Not Found (https://api.github.com/repos/stuarthopwood/refract)",
            "HTTP 403: API rate limit exceeded",
            "gh: command not found",
            "",
        ];
        for text in non_matching {
            assert!(
                !looks_offline(text),
                "expected no offline match for: {text}"
            );
        }
    }
}
