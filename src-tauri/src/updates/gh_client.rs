// Minimal `gh` CLI status wrapper for `updates::checker` (lane R11b, issue #794). Used to share
// its own, longer timeout with `updates::installer::download_update`'s ~146MB release-asset
// download rather than forking a second spawn-with-timeout implementation (gate finding, PR #829
// round 2, Medium). Keeps only what doesn't belong in the PR-management module: the update-
// specific `GithubCliStatus` mapping and offline-text matching.
//
// `git::git`'s shell-free `tokio::process::Command` wrapper pattern (no shell, `CREATE_NO_WINDOW`
// on Windows, `kill_on_drop(true)`, a bounded `tokio::time::timeout`) is reused here rather than
// re-derived.

use std::path::Path;
use std::time::Duration;

/// Port of `gh.ts`'s `GithubCliStatus` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubCliStatus {
    Ok,
    NotInstalled,
    NotSignedIn,
    Offline,
}

const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

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
/// `updates::checker::check_for_updates`). Never panics. An `Err` from the shared `gh_raw` --
/// meaning `gh` itself could not be resolved -- maps to `NotInstalled`; `gh_raw` never fails for a
/// network/auth failure, only for a missing `gh` (those surface as a non-zero `.code` instead).
pub async fn github_cli_status(cwd: &Path) -> GithubCliStatus {
    let auth = match crate::github::gh::gh_raw(cwd, &["auth", "status"], None, AUTH_STATUS_TIMEOUT)
        .await
    {
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
