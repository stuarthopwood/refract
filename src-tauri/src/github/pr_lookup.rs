// Port of `src/main/git/github.ts`: pull request lookup for the Session's own branch (spec 004
// FR-006, contracts/ipc.md), read-only, `gh` CLI, no shell, argument arrays only (same discipline
// as `git/git.rs`). Any failure -- `gh` not installed, not signed in, offline, rate limited, an
// unrecognised remote -- resolves to `Unavailable`, never a propagated error (FR-006, SC-007); a
// clean lookup that genuinely finds no open pull request is `None`, distinct from `Unavailable`.
//
// Deliberately independent of `github::gh`/`github::cli` (see those modules' own doc comments):
// this file keeps its own small `gh`-invocation and owner/repo-parsing logic, exactly as the TS
// source states it does relative to its spec-003 sibling.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::Deserialize;

use crate::git::git::git_raw;

/// Windows-only: `CREATE_NO_WINDOW` (same flag every other spawn in this crate applies) -- no
/// console window flashes for a `gh` child process.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TIMEOUT_MS: u64 = 5_000;

pub enum PullRequestLookup {
    Found { number: u64, url: String },
    None,
    Unavailable,
}

/// `owner/repo`, inferred from the repository's `origin` remote URL. Handles both the HTTPS
/// (`https://github.com/<owner>/<repo>.git`) and SSH (`git@github.com:<owner>/<repo>.git`) forms;
/// `.git` suffix and any trailing slash are stripped. `None` when there is no `origin` remote, or
/// it does not point at github.com (a self-hosted GitHub Enterprise remote is out of scope here).
fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    let trimmed = remote_url.trim();

    let lower = trimmed.to_lowercase();
    let strip_dot_git_and_slash = |s: &str| -> String {
        let s = s.strip_suffix('/').unwrap_or(s);
        s.strip_suffix(".git").unwrap_or(s).to_string()
    };

    if lower.starts_with("https://") || lower.starts_with("http://") {
        let scheme_len = if lower.starts_with("https://") { 8 } else { 7 };
        let rest = &trimmed[scheme_len..];
        // Optional `user@` prefix before the host.
        let host_and_path = match rest.find('/') {
            Some(idx) => (&rest[..idx], &rest[idx + 1..]),
            None => return None,
        };
        let host = host_and_path
            .0
            .rsplit('@')
            .next()
            .unwrap_or(host_and_path.0);
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        // `trim_end_matches` so a trailing slash (promised by this fn's own doc comment) does
        // not leave a trailing empty segment that would otherwise make `segments.len() != 2`.
        let path = host_and_path.1.trim_end_matches('/');
        let segments: Vec<&str> = path.split('/').collect();
        if segments.len() != 2 || segments[0].is_empty() || segments[1].is_empty() {
            return None;
        }
        let owner = segments[0].to_string();
        let repo = strip_dot_git_and_slash(segments[1]);
        if repo.is_empty() {
            return None;
        }
        return Some((owner, repo));
    }

    // SSH form: `git@github.com:<owner>/<repo>[.git][/]` (case-insensitive host).
    if let Some(colon_idx) = trimmed.find(':') {
        let (user_host, path) = (&trimmed[..colon_idx], &trimmed[colon_idx + 1..]);
        if user_host.eq_ignore_ascii_case("git@github.com") {
            let segments: Vec<&str> = path.split('/').collect();
            if segments.len() != 2 || segments[0].is_empty() || segments[1].is_empty() {
                return None;
            }
            let owner = segments[0].to_string();
            let repo = strip_dot_git_and_slash(segments[1]);
            if repo.is_empty() {
                return None;
            }
            return Some((owner, repo));
        }
    }

    None
}

#[derive(Deserialize)]
struct GhPrListEntry {
    number: u64,
    url: String,
    state: String,
}

/// Resolves `gh` on PATH, caching the first successful resolution for the process lifetime.
/// Deliberately a local copy of `github::gh`'s own `resolve_gh` (see this file's own doc
/// comment: kept independent on purpose) rather than an import of it.
fn resolve_gh_cached() -> Result<PathBuf, ()> {
    static CACHE: LazyLock<Result<PathBuf, ()>> =
        LazyLock::new(|| which::which_global("gh").map_err(|_| ()));
    CACHE.clone()
}

/// The Session's open pull request for `branch` (spec 004 FR-006). Never fails: every error path
/// below resolves to `PullRequestLookup::Unavailable` instead of propagating.
pub async fn pull_request_for_branch(repo_path: &Path, branch: &str) -> PullRequestLookup {
    let remote_result = git_raw(repo_path, &["remote", "get-url", "origin"], None).await;
    if remote_result.code != 0 {
        return PullRequestLookup::Unavailable;
    }
    let Some((owner, repo)) = parse_owner_repo(&remote_result.stdout) else {
        return PullRequestLookup::Unavailable;
    };

    let Ok(gh_path) = resolve_gh_cached() else {
        return PullRequestLookup::Unavailable;
    };

    let mut command = tokio::process::Command::new(&gh_path);
    command
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--json",
            "number,url,state",
            "--repo",
            &format!("{owner}/{repo}"),
        ])
        .current_dir(repo_path)
        .creation_flags(CREATE_NO_WINDOW);
    command.kill_on_drop(true);

    let output_future = command.output();
    let output = match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), output_future).await
    {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return PullRequestLookup::Unavailable,
        Err(_) => return PullRequestLookup::Unavailable,
    };
    if !output.status.success() {
        return PullRequestLookup::Unavailable;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(entries) = serde_json::from_str::<Vec<GhPrListEntry>>(&stdout) else {
        return PullRequestLookup::Unavailable;
    };

    match entries.into_iter().find(|entry| entry.state == "OPEN") {
        Some(open) => PullRequestLookup::Found {
            number: open.number,
            url: open.url,
        },
        None => PullRequestLookup::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_owner_repo ---

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
    fn rejects_non_github_host() {
        assert_eq!(parse_owner_repo("https://gitlab.com/owner/repo.git"), None);
    }

    #[test]
    fn rejects_malformed_remote_url() {
        assert_eq!(parse_owner_repo("not a url at all"), None);
    }

    // --- GhPrListEntry / gh pr list --json parsing ---

    #[test]
    fn parses_open_pr_found_for_branch() {
        let fixture =
            r#"[{"number":42,"url":"https://github.com/owner/repo/pull/42","state":"OPEN"}]"#;
        let entries: Vec<GhPrListEntry> = serde_json::from_str(fixture).unwrap();
        let found = entries.into_iter().find(|entry| entry.state == "OPEN");
        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.number, 42);
        assert_eq!(found.url, "https://github.com/owner/repo/pull/42");
    }

    #[test]
    fn parses_no_pr_found_for_branch() {
        let fixture = "[]";
        let entries: Vec<GhPrListEntry> = serde_json::from_str(fixture).unwrap();
        assert!(entries
            .into_iter()
            .find(|entry| entry.state == "OPEN")
            .is_none());
    }

    #[test]
    fn parses_closed_pr_not_treated_as_open() {
        let fixture =
            r#"[{"number":7,"url":"https://github.com/owner/repo/pull/7","state":"CLOSED"}]"#;
        let entries: Vec<GhPrListEntry> = serde_json::from_str(fixture).unwrap();
        assert!(entries
            .into_iter()
            .find(|entry| entry.state == "OPEN")
            .is_none());
    }

    // --- resolve_gh_cached ---

    #[test]
    fn resolve_gh_cached_is_stable_across_calls() {
        // Caching means two calls in the same process always agree, whatever the outcome on
        // this machine (found or not found) -- the point under test is the stability, not a
        // specific `gh` installation.
        assert_eq!(resolve_gh_cached(), resolve_gh_cached());
    }
}
