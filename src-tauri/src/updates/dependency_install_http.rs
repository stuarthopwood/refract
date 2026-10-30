//! Low-level helpers for `dependency_install.rs`: allowlisted HTTP, process spawn, scratch dirs.

use std::env;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Stops spawned installers and PowerShell children from flashing a console window.
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &["github.com"];
/// GitHub's asset CDN hosts. A download may redirect only to these.
pub(super) const ALLOWED_REDIRECT_HOSTS: &[&str] = &[
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_REDIRECTS: u32 = 5;

pub(super) const FETCH_JSON_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounds connect only, so a slow body transfer is not cut off.
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Per-read timeout, so a slow but live download still completes.
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const MAX_DETAIL_LENGTH: usize = 200;

#[derive(Debug, Deserialize)]
pub(super) struct GhReleaseAsset {
    pub(super) name: String,
    pub(super) browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct GhLatestRelease {
    pub(super) assets: Vec<GhReleaseAsset>,
}

/// Collapses whitespace and caps the detail so raw stderr stays out of the UI.
pub(super) fn fail_detail(raw: &str, manual_hint: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let combined = if collapsed.is_empty() {
        manual_hint.to_string()
    } else {
        format!("{collapsed} {manual_hint}")
    };
    if combined.chars().count() > MAX_DETAIL_LENGTH {
        let truncated: String = combined.chars().take(MAX_DETAIL_LENGTH - 1).collect();
        format!("{truncated}\u{2026}")
    } else {
        combined
    }
}

/// Rejects non-https URLs and hosts outside `allowed_hosts` before `reqwest` sees them.
pub(super) fn assert_allowed_url(
    raw: &str,
    allowed_hosts: &[&str],
    label: &str,
) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| format!("{label} must be a valid URL"))?;
    if parsed.scheme() != "https" {
        return Err(format!("{label} must be an https URL"));
    }
    let host = parsed.host_str().unwrap_or("");
    if !allowed_hosts.contains(&host) {
        return Err(format!(
            "{label} host \"{host}\" is not on the allowed list ({})",
            allowed_hosts.join(", ")
        ));
    }
    Ok(parsed)
}

pub(super) fn allowlisted_client() -> Result<Client, String> {
    // Redirects are off; each hop is checked in `fetch_from_allowed_host`.
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .read_timeout(DOWNLOAD_READ_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))
}

/// Fetches a fixed GitHub API JSON endpoint.
pub(super) async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &Client,
    url: &str,
    label: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .header("User-Agent", "refract-dependency-install")
        .header("Accept", "application/vnd.github+json")
        .timeout(FETCH_JSON_TIMEOUT)
        .send()
        .await
        .map_err(|err| format!("{label} request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("{label} responded with HTTP {}", response.status()));
    }
    response
        .json::<T>()
        .await
        .map_err(|err| format!("{label} returned invalid JSON: {err}"))
}

/// Follows a download URL hop by hop, checking each redirect against the allowlist.
pub(super) async fn fetch_from_allowed_host(
    client: &Client,
    initial_url: &str,
    label: &str,
) -> Result<Response, String> {
    let mut current = assert_allowed_url(initial_url, ALLOWED_DOWNLOAD_HOSTS, label)?;
    for _ in 0..MAX_REDIRECTS {
        let response = client
            .get(current.clone())
            .header("User-Agent", "refract-dependency-install")
            .send()
            .await
            .map_err(|err| format!("{label} request failed: {err}"))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| format!("{label} redirected with no Location header"))?
                .to_string();
            let next = current
                .join(&location)
                .map_err(|_| format!("{label} redirected to an unparsable URL"))?;
            current = assert_allowed_url(next.as_str(), ALLOWED_REDIRECT_HOSTS, "Redirect target")?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("{label} responded with HTTP {status}"));
        }
        return Ok(response);
    }
    Err(format!("{label} redirected too many times"))
}

/// A unique scratch directory, so concurrent installs never collide. Cleaned up on drop.
pub(super) async fn scratch_dir() -> Result<ScratchDir, String> {
    let dir = env::temp_dir().join(format!("refract-dep-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| format!("failed to create a scratch directory: {err}"))?;
    Ok(ScratchDir(dir))
}

/// Removes its directory on drop. Sync because `Drop` cannot await; errors are ignored.
pub(super) struct ScratchDir(PathBuf);

impl std::ops::Deref for ScratchDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Keeps only the bare file name, so an asset name cannot escape the scratch directory.
pub(super) fn safe_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .filter(|candidate| !candidate.is_empty())
        .unwrap_or("download")
        .to_string()
}

/// Downloads to `dest_path`, failing rather than overwriting an existing file.
pub(super) async fn download_to_file(
    client: &Client,
    url: &str,
    dest_path: &Path,
    label: &str,
) -> Result<(), String> {
    let mut response = fetch_from_allowed_host(client, url, label).await?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest_path)
        .await
        .map_err(|err| format!("{label} failed to create destination file: {err}"))?;
    // Streams chunk by chunk so a ~65MB installer is never held in memory whole.
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("{label} download failed: {err}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("{label} failed to write destination file: {err}"))?;
    }
    // `sync_all` so the next process to run the file sees complete bytes on disk.
    file.flush()
        .await
        .map_err(|err| format!("{label} failed to flush destination file: {err}"))?;
    file.sync_all()
        .await
        .map_err(|err| format!("{label} failed to sync destination file: {err}"))?;
    Ok(())
}

/// Runs a process with a timeout. A non-zero exit is not an error; callers read the code.
pub(super) async fn run_process(
    exe_path: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(i32, String), String> {
    let mut command = Command::new(exe_path);
    command
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    let output = match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => return Err(format!("failed to launch {}: {err}", exe_path.display())),
        Err(_) => return Err(format!("{} timed out", exe_path.display())),
    };
    let code = output.status.code().unwrap_or(1);
    let message = if !output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    Ok((code, message))
}

pub(super) fn exit_detail(what: &str, code: i32, message: &str) -> String {
    if message.is_empty() {
        format!("{what} exited with code {code}")
    } else {
        format!("{what} exited with code {code}: {message}")
    }
}

/// Returns an absolute PowerShell path, never a bare name (avoids cwd-first lookup).
pub(super) fn resolve_powershell() -> PathBuf {
    if let Ok(path) = which::which_global("pwsh") {
        return path;
    }
    let system_root = env::var("SystemRoot")
        .or_else(|_| env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

pub(super) fn find_asset_by_suffix<'a>(
    assets: &'a [GhReleaseAsset],
    suffix: &str,
) -> Option<&'a GhReleaseAsset> {
    assets.iter().find(|asset| asset.name.ends_with(suffix))
}

/// Searches subfolders too, since the GitHub CLI zip extracts into a version-named folder.
pub(super) fn find_file_named<'a>(
    dir: &'a Path,
    name: &'a str,
) -> std::pin::Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = tokio::fs::read_dir(dir).await.ok()?;
        let mut subdirs = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let is_dir = entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false);
            if is_dir {
                subdirs.push(entry.path());
                continue;
            }
            if entry.file_name().to_str() == Some(name) {
                return Some(entry.path());
            }
        }
        for subdir in subdirs {
            if let Some(found) = find_file_named(&subdir, name).await {
                return Some(found);
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_allowed_url_accepts_the_initial_github_host() {
        let result = assert_allowed_url(
            "https://github.com/git-for-windows/git/releases/download/v2.47.0/Git-2.47.0-64-bit.exe",
            ALLOWED_DOWNLOAD_HOSTS,
            "Download URL",
        );
        assert!(result.is_ok());
    }

    #[test]
    fn assert_allowed_url_accepts_both_cdn_redirect_hosts() {
        for host in ALLOWED_REDIRECT_HOSTS {
            let url = format!("https://{host}/github-production-release-asset/1/asset.exe");
            assert!(
                assert_allowed_url(&url, ALLOWED_REDIRECT_HOSTS, "Redirect target").is_ok(),
                "expected {host} to be an allowed redirect host"
            );
        }
    }

    #[test]
    fn assert_allowed_url_rejects_a_disallowed_initial_host() {
        let result = assert_allowed_url(
            "https://evil.example.com/asset.exe",
            ALLOWED_DOWNLOAD_HOSTS,
            "Download URL",
        );
        assert!(result.is_err());
    }

    #[test]
    fn assert_allowed_url_rejects_a_disallowed_redirect_host() {
        let result = assert_allowed_url(
            "https://evil.example.com/asset.exe",
            ALLOWED_REDIRECT_HOSTS,
            "Redirect target",
        );
        assert!(result.is_err());
    }

    #[test]
    fn assert_allowed_url_rejects_a_non_https_scheme() {
        let result = assert_allowed_url(
            "http://github.com/asset.exe",
            ALLOWED_DOWNLOAD_HOSTS,
            "Download URL",
        );
        assert!(result.is_err());
    }

    fn asset(name: &str) -> GhReleaseAsset {
        GhReleaseAsset {
            name: name.to_string(),
            browser_download_url: format!("https://github.com/example/releases/download/v1/{name}"),
        }
    }

    #[test]
    fn find_asset_by_suffix_matches_the_github_cli_windows_zip() {
        let assets = vec![
            asset("gh_2.63.0_macOS_amd64.zip"),
            asset("gh_2.63.0_windows_amd64.zip"),
            asset("gh_2.63.0_windows_amd64.msi"),
        ];
        let found = find_asset_by_suffix(&assets, "_windows_amd64.zip");
        assert_eq!(
            found.map(|a| a.name.as_str()),
            Some("gh_2.63.0_windows_amd64.zip")
        );
    }

    #[test]
    fn find_asset_by_suffix_matches_the_git_for_windows_64_bit_installer() {
        let assets = vec![
            asset("Git-2.47.0-32-bit.exe"),
            asset("Git-2.47.0-64-bit.exe"),
        ];
        let found = find_asset_by_suffix(&assets, "-64-bit.exe");
        assert_eq!(
            found.map(|a| a.name.as_str()),
            Some("Git-2.47.0-64-bit.exe")
        );
    }

    #[test]
    fn find_asset_by_suffix_returns_none_when_nothing_matches() {
        let assets = vec![asset("gh_2.63.0_macOS_amd64.zip")];
        assert!(find_asset_by_suffix(&assets, "_windows_amd64.zip").is_none());
    }

    #[test]
    fn fail_detail_appends_the_manual_hint() {
        let detail = fail_detail("installer exited with code 1", "hint");
        assert!(detail.starts_with("installer exited with code 1"));
        assert!(detail.ends_with("hint"));
    }

    #[test]
    fn fail_detail_collapses_multi_line_whitespace() {
        let detail = fail_detail("line one\nline two\r\nline three", "hint");
        assert_eq!(detail, "line one line two line three hint");
    }

    #[test]
    fn fail_detail_caps_the_combined_length() {
        let raw = "x".repeat(400);
        let detail = fail_detail(&raw, "hint");
        assert_eq!(detail.chars().count(), MAX_DETAIL_LENGTH);
        assert!(detail.ends_with('\u{2026}'));
    }
}
