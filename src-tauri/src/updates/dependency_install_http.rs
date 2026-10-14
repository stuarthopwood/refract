// Shared low-level helpers for `dependency_install.rs` (lane R11b, issue #794): generic HTTP
// fetch/download with a fixed-host allowlist, process-spawn, scratch-directory, and
// failure-detail-formatting plumbing used by every one of `install_git`/`install_omp`/
// `install_github_cli`. Split out purely to keep that file under the 600-line soft cap
// (`AGENTS.md` "No god files") -- every item here is `pub(super)`, internal to `updates`, not
// part of this crate's public surface.

use std::env;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Same flag `git::git`'s `git_raw` applies: no console window flashes for a spawned installer,
/// extraction, or PowerShell child.
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &["github.com"];
/// GitHub's release-asset CDN redirects a `github.com/.../releases/download/...` URL to one of
/// these hosts; a download must never be allowed to land anywhere else.
pub(super) const ALLOWED_REDIRECT_HOSTS: &[&str] = &[
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_REDIRECTS: u32 = 5;

pub(super) const FETCH_JSON_TIMEOUT: Duration = Duration::from_secs(15);
/// Perf/security remediation (gate round 1, issue #794): bounds only the connect phase of a
/// download request, never the body transfer -- see `allowlisted_client`'s own doc comment for
/// why a flat total-request timeout was replaced with this plus `DOWNLOAD_READ_TIMEOUT`.
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Bounds a single body read/chunk, resetting after every successful read
/// (`reqwest::ClientBuilder::read_timeout`'s own semantics) -- a multi-minute transfer at a
/// trickle still succeeds as long as no individual read ever stalls this long.
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

/// Quality-gate remediation: every failure detail could be a raw multi-line stderr dump or a
/// long caught-error message; the readiness screen's progress text must never show either.
/// Collapses whitespace, appends a manual-install hint, and caps the whole combined string.
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

/// Security (constitution V): every fetch this module performs is to a fixed, hard-coded host
/// list, never a caller-supplied value. Validates `raw` is an `https` URL whose host is in
/// `allowed_hosts` before it is ever handed to `reqwest`.
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
    // `redirect(Policy::none())`: every hop is inspected and allowlisted manually below, rather
    // than letting `reqwest` silently follow a response wherever it points -- `fetch_from_
    // allowed_host`'s whole reason to exist.
    //
    // `connect_timeout`/`read_timeout` (perf/security remediation, gate round 1): a download
    // used to carry a single flat 120s *total* request timeout covering the whole body transfer,
    // which doesn't reset as bytes keep arriving -- a ~65MB Git for Windows installer fails
    // below roughly 4.5 Mbit/s even on an otherwise-healthy slow connection. `connect_timeout`
    // bounds only the initial connect/response-headers phase; `read_timeout` bounds each
    // individual body read and resets after every successful one, so a multi-minute transfer at
    // a trickle still succeeds as long as no single read ever stalls this long. `fetch_json`
    // still layers its own short per-request `.timeout(FETCH_JSON_TIMEOUT)` total-timeout
    // override on top of this same client for the small, fast GitHub API JSON calls.
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .read_timeout(DOWNLOAD_READ_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))
}

/// Fetches a fixed, hard-coded GitHub API JSON endpoint (never a caller-supplied URL).
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

/// Follows a download URL that originates from GitHub's own API response (`browser_download_
/// url`), validating every hop -- including each redirect -- against a fixed host allowlist
/// before issuing the next request. `reqwest`'s own redirect-follow is disabled on the client
/// (`allowlisted_client`), so every 3xx here is inspected manually.
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

/// A fresh, uuid-named scratch directory under the OS temp root, so two concurrent installs of
/// the same dependency can never collide on the same download/extraction path. Returns an RAII
/// guard (`ScratchDir`, derefs to `Path`) rather than a bare `PathBuf`: every caller's directory
/// otherwise stuck around in `%TEMP%` forever, since nothing previously removed it after a
/// dependency install finished -- success or failure.
pub(super) async fn scratch_dir() -> Result<ScratchDir, String> {
    let dir = env::temp_dir().join(format!("refract-dep-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| format!("failed to create a scratch directory: {err}"))?;
    Ok(ScratchDir(dir))
}

/// RAII guard returned by `scratch_dir`: best-effort deletes its directory tree on `Drop`, so a
/// dependency install never leaks its scratch folder regardless of which `?` return path a
/// caller takes. Uses `std::fs::remove_dir_all` rather than the `tokio::fs` version -- `Drop`
/// cannot run async code, and this brief synchronous blocking is acceptable for a small, bounded
/// cleanup, not a hot path. Errors are swallowed: a failed best-effort cleanup must never panic
/// or fail a caller that may already be unwinding.
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

/// Strips any directory component a GitHub-API-sourced asset name might contain, so only the
/// bare file name is ever used to build a path on disk.
pub(super) fn safe_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .filter(|candidate| !candidate.is_empty())
        .unwrap_or("download")
        .to_string()
}

/// Downloads `url` (already validated per-hop by `fetch_from_allowed_host`) to `dest_path`,
/// refusing to overwrite an existing file rather than silently clobbering one -- `dest_path`
/// always lives inside this call's own fresh `scratch_dir`, so a collision here would only ever
/// mean a real bug, not routine contention.
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
    // Streamed chunk-by-chunk (perf remediation, gate round 1): the Git for Windows installer is
    // roughly 60-70MB and the GitHub CLI zip roughly 15MB -- buffering the whole response with
    // `response.bytes()` before a single `write_all` held the entire asset in memory at once.
    // `Response::chunk` (no extra `reqwest` feature needed) keeps memory flat at one chunk
    // regardless of asset size.
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("{label} download failed: {err}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("{label} failed to write destination file: {err}"))?;
    }
    // Gate finding: a successful `write_all` only means the bytes reached the OS buffer cache,
    // not that they are durable on disk or even fully visible to whatever this file's caller
    // runs next (e.g. `bsdtar`/the installer `.exe` itself) -- `flush` then `sync_all` (the
    // stronger, data-durable guarantee `flush` alone does not promise under tokio) before this
    // function ever reports success.
    file.flush()
        .await
        .map_err(|err| format!("{label} failed to flush destination file: {err}"))?;
    file.sync_all()
        .await
        .map_err(|err| format!("{label} failed to sync destination file: {err}"))?;
    Ok(())
}

/// Runs `exe_path args` with no shell, bounded by `timeout`; never fails on a non-zero exit,
/// callers branch on the returned exit code. `kill_on_drop` matches `git::git`'s own wrapper: a
/// timed-out child is reaped rather than left running as an orphan.
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

/// Finds the official PowerShell 7+ binary on PATH if present, else falls back to the fixed
/// Windows PowerShell 5.1 system path -- never a bare name passed to `Command::new` (same
/// cwd-before-PATH `CreateProcess` risk `executables.rs`'s own doc comments describe). A sibling
/// file in this same lane (`install_on_quit.rs`) needs this exact same small fallback; a little
/// duplicated logic between the two is expected rather than sharing a module for it.
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

/// Walks `dir` looking for a file literally named `name` -- the GitHub CLI's zip extracts into a
/// version-named subfolder whose exact name varies by release, so the path cannot be hard-coded.
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
