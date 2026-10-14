// `gh` CLI sign-in status for `updates::checker::check_for_updates` (lane R11b, issue #794).
// Shares the shared `github::gh::gh_raw`/`resolve_gh` directly (gate finding, PR #829 round 2,
// Medium: this file used to duplicate its own `gh_raw`/`GhRawResult`/spawn-with-timeout runner
// purely because the shared one had no configurable timeout; it now takes one). Keeps only what
// doesn't belong in the PR-management module: the update-specific `GithubCliStatus` mapping and
// offline-text matching -- `updates::installer::download_update` calls `github::gh::gh_raw`
// directly for its own download, not through this file.

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
    // Gate finding (round 3, Medium): the shared `gh_raw`'s own timeout path never writes
    // "timed out" (or any text at all) to stdout/stderr -- `timed_out` is the only signal a spawn
    // itself stalled, so it must be checked explicitly, before `looks_offline`'s text match (which
    // exists for `gh`'s OWN reported network-timeout text, a different case) ever runs against
    // what would otherwise be two empty strings and silently fall through to `NotSignedIn`.
    if auth.timed_out || looks_offline(&format!("{}\n{}", auth.stdout, auth.stderr)) {
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
