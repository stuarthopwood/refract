// Repository remotes (port of `git/remote.ts`), part of session worktree and lifecycle (lane R2,
// issue #785). Pre-declared so lane R2 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// Generic (not GitHub-specific) remote detection for the Session list's group-header icons
// (issue #528): whether a repository has ANY configured remote, and that remote's host when it
// does -- used only to pick an icon and its tooltip text, never to open a link or reach the
// network.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::git::git::git_raw;

/// `repositoryRemote`'s own per-call bound (`remote.ts`'s `TIMEOUT_MS`): long enough for a
/// normal `git config` read, short enough that a hung or missing `git` can never block the
/// Session list for long.
const REMOTE_CHECK_TIMEOUT_MS: u64 = 3000;

/// `src/shared/model.ts`'s `RepositoryRemote` union. `rename_all_fields` (not `rename_all`, which
/// only renames variant tags) is this crate's convention for an enum with a struct variant
/// (`session/agent/types.rs`'s `PendingRequest`); `Has`'s own `host` field is already a single
/// lowercase word so it round-trips unchanged either way, but each variant's tag still needs its
/// own explicit `rename` since `rename_all_fields` never touches tag names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum RepositoryRemoteKind {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "has")]
    Has {
        host: String,
        /// Issue #646: `owner` and `repo` parsed from the remote URL path, only for the tooltip.
        /// Absent when the path does not hold at least two segments.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
    },
    #[serde(rename = "unknown")]
    Unknown,
}

/// Git itself treats a drive-letter prefix (`C:/...`, `C:\...`) as a LOCAL path, never a remote
/// host (`remote.ts` gate round 1 fix) -- without this check it would match the scp-like form
/// below and report a false host of a single letter.
fn is_windows_drive_path(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// The scp-like SSH form (`user@host:owner/repo.git`, no `://` scheme). Mirrors `remote.ts`'s
/// own `/^(?:[^/]*@)?([^:/@]+):/`: the optional userinfo prefix is the longest run of non-`/`
/// characters ending in the LAST `@` before the first `/` (so a userinfo segment that itself
/// embeds an `@`, e.g. `a@b@host:path`, can never leak into the reported host); the host itself
/// is then the longest run of characters that are none of `:`, `/`, `@`, immediately followed by
/// a literal `:`. An IPv6-literal false match (`git@[fe80::1]:repo`) is rejected by the shared
/// `[`-guard below, same as `remote.ts`'s own gate round 2 fix.
fn scp_like_parts(trimmed: &str) -> Option<(String, &str)> {
    let search_region = match trimmed.find('/') {
        Some(slash) => &trimmed[..slash],
        None => trimmed,
    };
    let host_start = match search_region.rfind('@') {
        Some(at) => at + 1,
        None => 0,
    };
    let rest = &trimmed[host_start..];
    let host_len = rest.find([':', '/', '@']).unwrap_or(rest.len());
    if host_len == 0 || host_len >= rest.len() || rest.as_bytes()[host_len] != b':' {
        return None;
    }
    let host = &rest[..host_len];
    if host.contains('[') {
        return None;
    }
    Some((host.to_lowercase(), &rest[host_len + 1..]))
}

/// Any other remote URL (`https://`, `ssh://`, `git://`, ...): the bare authority host, userinfo
/// and port stripped, matching `new URL(trimmed).hostname`. No `url` crate dependency in this
/// build's `Cargo.toml`, so parsed manually: find `://`, then the authority up to the next `/`,
/// `?`, or `#`, strip a userinfo segment before the last `@` in that authority. An IPv6 literal's
/// `hostname` keeps its brackets (`[::1]`) in that Web API too, so it is produced here the same
/// way and then rejected by the shared `[`-guard below, exactly like `remote.ts`.
fn url_parts(trimmed: &str) -> Option<(String, &str)> {
    let scheme_end = trimmed.find("://")? + 3;
    let after_scheme = &trimmed[scheme_end..];
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let path = &after_scheme[authority_end..];
    let host_and_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    let host = if let Some(stripped) = host_and_port.strip_prefix('[') {
        let closing = stripped.find(']')?;
        &host_and_port[..=closing + 1]
    } else {
        let end = host_and_port.find(':').unwrap_or(host_and_port.len());
        &host_and_port[..end]
    };
    if host.is_empty() || host.contains('[') {
        return None;
    }
    Some((host.to_lowercase(), path))
}

/// The bare authority host from a git remote URL, with any userinfo/credentials stripped before
/// it ever leaves this function (a remote URL can embed a token, for example
/// `https://x-access-token:ghp_xxx@github.com/owner/repo.git`) -- a privacy requirement, never a
/// display nicety. Handles the scp-like SSH form (`user@host:owner/repo.git`, no scheme) in
/// addition to any `://`-schemed URL (`https://`, `ssh://`, `git://`, ...).
#[cfg(test)]
fn host_from_remote_url(url: &str) -> Option<String> {
    remote_parts(url).map(|(host, _)| host)
}

fn remote_parts(url: &str) -> Option<(String, &str)> {
    let trimmed = url.trim();
    if is_windows_drive_path(trimmed) {
        return None;
    }
    if !trimmed.contains("://") {
        return scp_like_parts(trimmed);
    }
    url_parts(trimmed)
}

/// Issue #646: `(owner, repo)` from a remote URL path, for the tooltip only. `repo` is the last
/// segment without `.git`; `owner` is every segment before it (a GitLab subgroup path stays
/// whole). `None` when fewer than two segments remain.
fn owner_repo_from_path(path: &str) -> Option<(String, String)> {
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let last = segments.pop()?;
    let repo = last.strip_suffix(".git").unwrap_or(last);
    if repo.is_empty() || segments.is_empty() {
        return None;
    }
    Some((segments.join("/"), repo.to_string()))
}

/// `Repository.remote` (issue #528): read-only, no network call, and bounded so a hung or missing
/// `git` can never block the Session list for long. `None` means this call never got a settled
/// answer at all (its own 3s timeout fired), so the caller should treat that the same as "absent"
/// and keep whatever value it already had; `Some(RepositoryRemoteKind::Unknown)` means the check
/// ran to completion and genuinely could not tell (a real git failure, an unparseable remote,
/// ...). Simplified from `remote.ts`'s own `AbortSignal.any([timeoutSignal, deadline])`
/// combinator down to a single `tokio::time::timeout`: this build has no shared-deadline pool yet
/// (`ipc::repositories::repositories_remotes`, the only caller, loops sequentially -- each call
/// is already bounded by this same per-call timeout, so a sequential loop stays bounded too, just
/// slower for many repositories).
pub async fn repository_remote(repo_path: &Path) -> Option<RepositoryRemoteKind> {
    let git_dir_exists = tokio::fs::symlink_metadata(repo_path.join(".git"))
        .await
        .is_ok();
    if !git_dir_exists {
        return Some(RepositoryRemoteKind::Unknown);
    }
    let timed = tokio::time::timeout(
        Duration::from_millis(REMOTE_CHECK_TIMEOUT_MS),
        git_raw(
            repo_path,
            &["config", "--local", "--includes", "--list", "-z"],
            None,
        ),
    )
    .await;
    let result = match timed {
        Ok(result) => result,
        Err(_) => return None,
    };
    if result.code != 0 {
        return Some(RepositoryRemoteKind::Unknown);
    }
    let entries: Vec<(&str, &str)> = result
        .stdout
        .split('\0')
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let (key, url) = match record.find('\n') {
                Some(idx) => (&record[..idx], &record[idx + 1..]),
                None => (record, ""),
            };
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            if name.is_empty() || url.is_empty() {
                None
            } else {
                Some((name, url))
            }
        })
        .collect();
    if entries.is_empty() {
        return Some(RepositoryRemoteKind::None);
    }
    let preferred = entries
        .iter()
        .find(|entry| entry.0 == "origin")
        .copied()
        .unwrap_or(entries[0]);
    match remote_parts(preferred.1) {
        Some((host, path)) => {
            let (owner, repo) = match owner_repo_from_path(path) {
                Some((owner, repo)) => (Some(owner), Some(repo)),
                None => (None, None),
            };
            Some(RepositoryRemoteKind::Has { host, owner, repo })
        }
        None => Some(RepositoryRemoteKind::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "refract-remote-test-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git must be on PATH for this test");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    #[test]
    fn host_from_remote_url_reads_a_plain_https_url() {
        assert_eq!(
            host_from_remote_url("https://github.com/owner/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn host_from_remote_url_strips_embedded_userinfo_credentials() {
        assert_eq!(
            host_from_remote_url("https://x-access-token:ghp_xxx@github.com/owner/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn host_from_remote_url_reads_the_scp_like_ssh_form() {
        assert_eq!(
            host_from_remote_url("git@github.com:owner/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn host_from_remote_url_rejects_windows_drive_letter_paths() {
        assert_eq!(host_from_remote_url("C:/repos/pinion"), None);
        assert_eq!(host_from_remote_url("C:\\repos\\pinion"), None);
    }

    #[test]
    fn host_from_remote_url_rejects_ipv6_literal_hosts() {
        assert_eq!(host_from_remote_url("[::1]"), None);
        assert_eq!(host_from_remote_url("git@[::1]:repo"), None);
    }

    #[test]
    fn host_from_remote_url_lowercases_the_host() {
        assert_eq!(
            host_from_remote_url("HTTPS://GitHub.COM/owner/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[tokio::test]
    async fn repository_remote_returns_unknown_when_no_git_entry_exists() {
        let dir = temp_dir("no-git");
        assert_eq!(
            repository_remote(&dir).await,
            Some(RepositoryRemoteKind::Unknown)
        );
    }

    #[tokio::test]
    async fn repository_remote_returns_has_host_for_a_configured_remote() {
        let dir = temp_dir("has-remote");
        run_git(&dir, &["init", "-q"]);
        run_git(
            &dir,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git",
            ],
        );
        assert_eq!(
            repository_remote(&dir).await,
            Some(RepositoryRemoteKind::Has {
                host: "github.com".to_string(),
                owner: Some("owner".to_string()),
                repo: Some("repo".to_string())
            })
        );
    }

    /// Distinct from the `Option` wrapper's own `None` (a timed-out check, "no settled answer"):
    /// this asserts the SETTLED `RepositoryRemoteKind::None` variant, for a repository the check
    /// ran to completion against and genuinely has no configured remote.
    #[tokio::test]
    async fn repository_remote_returns_the_settled_none_variant_when_no_remote_is_configured() {
        let dir = temp_dir("no-remote");
        run_git(&dir, &["init", "-q"]);
        assert_eq!(
            repository_remote(&dir).await,
            Some(RepositoryRemoteKind::None)
        );
    }
}
