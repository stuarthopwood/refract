// Remote detection for Session list icons; never opens a link or touches the network.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::git::git::git_raw;

/// Per-call bound so a hung or missing `git` cannot block the Session list.
const REMOTE_CHECK_TIMEOUT_MS: u64 = 3000;

/// Repository remote state, mirroring the shared `RepositoryRemote` union.
// `rename_all_fields` never renames tags, so each variant carries an explicit `rename`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum RepositoryRemoteKind {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "has")]
    Has {
        host: String,
        /// Tooltip-only owner/repo; absent when the path has fewer than two segments.
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
    },
    #[serde(rename = "unknown")]
    Unknown,
}

// Git treats `C:/...` as a local path; otherwise it would match scp-like as host "c".
fn is_windows_drive_path(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Parses the scp-like SSH form (`user@host:owner/repo.git`).
// Userinfo ends at the LAST `@` before the first `/`, so `a@b@host:path` cannot leak into host.
// IPv6 literals are rejected by the `[`-guard.
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

/// Parses a `://` remote URL into host (userinfo and port stripped) and path.
// Hand-parsed: no `url` crate dependency. IPv6 literals keep brackets and are rejected by the `[`-guard.
fn url_parts(trimmed: &str) -> Option<(String, &str)> {
    let scheme_end = trimmed.find("://")? + 3;
    let after_scheme = &trimmed[scheme_end..];
    // Last `@` before `?`/`#`, so a password containing `/` cannot leak into `owner`.
    let before_query = after_scheme
        .find(['?', '#'])
        .map_or(after_scheme, |end| &after_scheme[..end]);
    let without_userinfo = match before_query.rfind('@') {
        Some(at) => &after_scheme[at + 1..],
        None => after_scheme,
    };
    let authority_end = without_userinfo
        .find(['/', '?', '#'])
        .unwrap_or(without_userinfo.len());
    let host_and_port = &without_userinfo[..authority_end];
    let path = &without_userinfo[authority_end..];
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

/// Host of a remote URL. Userinfo (tokens) must be stripped before the host leaves this module (privacy).
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

/// `(owner, repo)` from a remote URL path; owner keeps GitLab subgroups whole.
fn owner_repo_from_path(path: &str) -> Option<(String, String)> {
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let last = segments.pop()?;
    let repo = last.strip_suffix(".git").unwrap_or(last);
    if repo.is_empty() || segments.is_empty() {
        return None;
    }
    // Non-plain characters drop owner/repo, not the host.
    let is_plain = |segment: &str| {
        segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    if !is_plain(repo) || !segments.iter().all(|segment| is_plain(segment)) {
        return None;
    }
    Some((segments.join("/"), repo.to_string()))
}

/// Read-only, bounded remote check; `None` means it timed out, `Unknown` means it ran but could not tell.
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
        let dir = crate::test_scratch::path(format!(
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

    /// Asserts the settled `None` variant, distinct from the timed-out `Option::None`.
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
