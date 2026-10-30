// `gh` sign-in status for the update checker, built on the shared `github::gh::gh_raw`.

use std::path::Path;
use std::time::Duration;

/// Sign-in state of the `gh` CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubCliStatus {
    Ok,
    NotInstalled,
    NotSignedIn,
    Offline,
}

const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

// Hand-matched network-error substrings (no regex crate here); case-insensitive.
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

/// Checks whether `gh` is installed and signed in. An `Err` from `gh_raw` means `gh` is missing.
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
    // A stalled spawn writes no text, so `timed_out` must be checked explicitly.
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
