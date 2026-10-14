// Port of `src/main/dependencyInstall.ts` (lane R11b, issue #794): installs Git for Windows, omp,
// and the GitHub CLI from a first-run readiness checklist Install action, each as a single
// no-admin, unattended background install reporting progress through
// `DependencyInstallProgress` (contracts/ipc.md, data-model.md). The mined file's own comments
// document every quality-gate-remediation fix this port carries forward: a fixed download-host
// allowlist with manual redirect-following (`fetch_from_allowed_host`), a fresh-scratch-directory-
// per-call so two concurrent installs of the same dependency can never collide (`scratch_dir`),
// capped/sanitised failure-detail strings (`fail_detail`), and a pinned-tag install-script URL for
// omp rather than a moving `main`-branch redirect.
//
// Three deliberate deviations from the mined TS, confirmed by this issue's own probes
// (specs/016-tauri-rust-build/installer-probes.md, "Mined reference inventory"):
//
// - GitHub CLI: the portable zip, never the per-machine MSI (no admin prompt, no elevation UI).
//   Extracted with Windows' own bundled bsdtar (`tar_exe_path`) to a fixed per-user install path,
//   `%LOCALAPPDATA%\refract\tools\gh\gh.exe`.
// - omp: pinned to `OMP_PINNED_TAG` below (a point-in-time pin confirmed current against this
//   issue's own probe machine; update this one constant when a newer line needs supporting), and
//   fetched from a tag-pinned raw.githubusercontent.com URL, never the moving `main`-branch
//   redirect `https://omp.sh/install.ps1` resolves to.
// - git has no equivalent of the TS's generic `primeExecutableCache` in this build: the Rust git
//   resolver's cache (`git::git::GIT_PATH`) is owned by a different lane's file, out of scope
//   here. `install_git`'s own `done` event therefore always sets `restart_required: true` instead
//   of probing a fixed path and priming in-process the way `install_omp` does below -- a
//   deliberate, narrower-than-upstream choice for this port.

use std::env;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::process::executables::{prime_omp_cache, tar_exe_path};

/// Same flag `git::git`'s `git_raw` applies: no console window flashes for a spawned installer,
/// extraction, or PowerShell child.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &["github.com"];
/// GitHub's release-asset CDN redirects a `github.com/.../releases/download/...` URL to one of
/// these hosts; a download must never be allowed to land anywhere else.
const ALLOWED_REDIRECT_HOSTS: &[&str] = &[
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_REDIRECTS: u32 = 5;

const FETCH_JSON_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_DETAIL_LENGTH: usize = 200;

const GIT_RELEASES_API: &str = "https://api.github.com/repos/git-for-windows/git/releases/latest";
const GITHUB_CLI_RELEASES_API: &str = "https://api.github.com/repos/cli/cli/releases/latest";
const GIT_ASSET_SUFFIX: &str = "-64-bit.exe";
const GITHUB_CLI_ASSET_SUFFIX: &str = "_windows_amd64.zip";

/// Point-in-time pin, confirmed current against this issue's own probe machine
/// (specs/016-tauri-rust-build/installer-probes.md). If a different tag is needed, update this
/// one constant -- never let the install URL below silently track a moving branch instead.
const OMP_PINNED_TAG: &str = "v18.10.1";

const GIT_MANUAL_HINT: &str =
    "If this keeps failing, install Git for Windows yourself from git-scm.com and choose Re-check.";
const OMP_MANUAL_HINT: &str = "If this keeps failing, install omp yourself and choose Re-check.";
const GITHUB_CLI_MANUAL_HINT: &str =
    "If this keeps failing, install the GitHub CLI yourself from cli.github.com and choose Re-check.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dependency {
    Git,
    Omp,
    GithubCli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    Downloading,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInstallProgress {
    pub dependency: Dependency,
    pub phase: InstallPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_required: Option<bool>,
}

fn progress(
    dependency: Dependency,
    phase: InstallPhase,
    detail: Option<String>,
    restart_required: Option<bool>,
) -> DependencyInstallProgress {
    DependencyInstallProgress {
        dependency,
        phase,
        detail,
        restart_required,
    }
}

#[derive(Debug, Deserialize)]
struct GhReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GhLatestRelease {
    assets: Vec<GhReleaseAsset>,
}

/// Quality-gate remediation: every failure detail could be a raw multi-line stderr dump or a
/// long caught-error message; the readiness screen's progress text must never show either.
/// Collapses whitespace, appends a manual-install hint, and caps the whole combined string.
fn fail_detail(raw: &str, manual_hint: &str) -> String {
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
fn assert_allowed_url(raw: &str, allowed_hosts: &[&str], label: &str) -> Result<Url, String> {
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

fn allowlisted_client() -> Result<Client, String> {
    // `redirect(Policy::none())`: every hop is inspected and allowlisted manually below, rather
    // than letting `reqwest` silently follow a response wherever it points -- `fetch_from_
    // allowed_host`'s whole reason to exist.
    Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))
}

/// Fetches a fixed, hard-coded GitHub API JSON endpoint (never a caller-supplied URL).
async fn fetch_json<T: serde::de::DeserializeOwned>(
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
async fn fetch_from_allowed_host(
    client: &Client,
    initial_url: &str,
    label: &str,
) -> Result<Response, String> {
    let mut current = assert_allowed_url(initial_url, ALLOWED_DOWNLOAD_HOSTS, label)?;
    for _ in 0..MAX_REDIRECTS {
        let response = client
            .get(current.clone())
            .header("User-Agent", "refract-dependency-install")
            .timeout(DOWNLOAD_TIMEOUT)
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
/// the same dependency can never collide on the same download/extraction path.
async fn scratch_dir() -> Result<PathBuf, String> {
    let dir = env::temp_dir().join(format!("refract-dep-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| format!("failed to create a scratch directory: {err}"))?;
    Ok(dir)
}

/// Strips any directory component a GitHub-API-sourced asset name might contain, so only the
/// bare file name is ever used to build a path on disk.
fn safe_file_name(name: &str) -> String {
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
async fn download_to_file(
    client: &Client,
    url: &str,
    dest_path: &Path,
    label: &str,
) -> Result<(), String> {
    let response = fetch_from_allowed_host(client, url, label).await?;
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("{label} download failed: {err}"))?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest_path)
        .await
        .map_err(|err| format!("{label} failed to create destination file: {err}"))?;
    file.write_all(&bytes)
        .await
        .map_err(|err| format!("{label} failed to write destination file: {err}"))?;
    Ok(())
}

/// Runs `exe_path args` with no shell, bounded by `timeout`; never fails on a non-zero exit,
/// callers branch on the returned exit code. `kill_on_drop` matches `git::git`'s own wrapper: a
/// timed-out child is reaped rather than left running as an orphan.
async fn run_process(
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

fn exit_detail(what: &str, code: i32, message: &str) -> String {
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
fn resolve_powershell() -> PathBuf {
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

fn find_asset_by_suffix<'a>(
    assets: &'a [GhReleaseAsset],
    suffix: &str,
) -> Option<&'a GhReleaseAsset> {
    assets.iter().find(|asset| asset.name.ends_with(suffix))
}

/// Walks `dir` looking for a file literally named `name` -- the GitHub CLI's zip extracts into a
/// version-named subfolder whose exact name varies by release, so the path cannot be hard-coded.
fn find_file_named<'a>(
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

/// Fetches the latest Git for Windows release, downloads its 64-bit installer, and runs it
/// unattended (research.md decision 6: a per-user, no-admin, silent install). Never primes any
/// in-process cache on success -- see this file's own header comment for why that is a
/// deliberate, narrower-than-upstream choice here.
pub async fn install_git(on_progress: impl Fn(DependencyInstallProgress)) -> Result<(), String> {
    let result = install_git_inner(&on_progress).await;
    if let Err(detail) = &result {
        on_progress(progress(
            Dependency::Git,
            InstallPhase::Failed,
            Some(detail.clone()),
            None,
        ));
    }
    result
}

async fn install_git_inner(on_progress: &impl Fn(DependencyInstallProgress)) -> Result<(), String> {
    on_progress(progress(
        Dependency::Git,
        InstallPhase::Downloading,
        None,
        None,
    ));
    let client = allowlisted_client()?;
    let release: GhLatestRelease =
        fetch_json(&client, GIT_RELEASES_API, "Git for Windows release list")
            .await
            .map_err(|err| fail_detail(&err, GIT_MANUAL_HINT))?;
    let asset = find_asset_by_suffix(&release.assets, GIT_ASSET_SUFFIX).ok_or_else(|| {
        fail_detail(
            "Could not find a 64-bit Git for Windows installer in the latest release.",
            GIT_MANUAL_HINT,
        )
    })?;

    let dir = scratch_dir()
        .await
        .map_err(|err| fail_detail(&err, GIT_MANUAL_HINT))?;
    let installer_path = dir.join(safe_file_name(&asset.name));
    download_to_file(
        &client,
        &asset.browser_download_url,
        &installer_path,
        "Git for Windows installer",
    )
    .await
    .map_err(|err| fail_detail(&err, GIT_MANUAL_HINT))?;

    on_progress(progress(Dependency::Git, InstallPhase::Running, None, None));
    let (code, message) = run_process(
        &installer_path,
        &[
            "/VERYSILENT",
            "/NORESTART",
            "/NOCANCEL",
            "/SP-",
            "/CURRENTUSER",
        ],
        PROCESS_TIMEOUT,
    )
    .await
    .map_err(|err| fail_detail(&err, GIT_MANUAL_HINT))?;
    if code != 0 {
        return Err(fail_detail(
            &exit_detail("Git for Windows installer", code, &message),
            GIT_MANUAL_HINT,
        ));
    }

    on_progress(progress(
        Dependency::Git,
        InstallPhase::Done,
        None,
        Some(true),
    ));
    Ok(())
}

/// Invokes omp's own official install script with a pinned, supported tag (research.md decisions
/// 6 and 7): the script does its own download and install in one PowerShell invocation, so there
/// is no separate Refract-side `downloading` phase here, only `running` for the whole
/// invocation.
pub async fn install_omp(on_progress: impl Fn(DependencyInstallProgress)) -> Result<(), String> {
    let result = install_omp_inner(&on_progress).await;
    if let Err(detail) = &result {
        on_progress(progress(
            Dependency::Omp,
            InstallPhase::Failed,
            Some(detail.clone()),
            None,
        ));
    }
    result
}

async fn install_omp_inner(on_progress: &impl Fn(DependencyInstallProgress)) -> Result<(), String> {
    on_progress(progress(Dependency::Omp, InstallPhase::Running, None, None));
    let pwsh = resolve_powershell();
    // Built from ONLY this module's own fixed constants -- never any caller-supplied value
    // (constitution V / security: a moving `-Ref` or an injected script URL would be a
    // supply-chain risk).
    let script_url = format!(
        "https://raw.githubusercontent.com/can1357/oh-my-pi/{OMP_PINNED_TAG}/scripts/install.ps1"
    );
    let script =
        format!("& ([scriptblock]::Create((irm {script_url}))) -Binary -Ref {OMP_PINNED_TAG}");
    let (code, message) = run_process(
        &pwsh,
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        PROCESS_TIMEOUT,
    )
    .await
    .map_err(|err| fail_detail(&err, OMP_MANUAL_HINT))?;
    if code != 0 {
        return Err(fail_detail(
            &exit_detail("omp install script", code, &message),
            OMP_MANUAL_HINT,
        ));
    }

    // This process's in-memory PATH does not pick up the script's own `User`-scope
    // `SetEnvironmentVariable` write, so an immediate `readiness.check()` right after a
    // successful install would otherwise still report `omp` missing until Refract is relaunched.
    let local_app_data = env::var("LOCALAPPDATA")
        .map_err(|_| fail_detail("LOCALAPPDATA is not set", OMP_MANUAL_HINT))?;
    let candidate = PathBuf::from(local_app_data).join("omp").join("omp.exe");
    let found = tokio::fs::try_exists(&candidate).await.unwrap_or(false);
    if found {
        prime_omp_cache(candidate);
        on_progress(progress(Dependency::Omp, InstallPhase::Done, None, None));
    } else {
        on_progress(progress(
            Dependency::Omp,
            InstallPhase::Done,
            None,
            Some(true),
        ));
    }
    Ok(())
}

/// Fetches the latest GitHub CLI release, downloads its Windows amd64 **portable zip** (never the
/// per-machine MSI: research.md decision 6), extracts it with Windows' own bundled `bsdtar`, and
/// copies the extracted `gh.exe` to a fixed per-user install path, `%LOCALAPPDATA%\refract\
/// tools\gh\gh.exe` -- `gh_client.rs` checks this exact path first, so no in-process priming call
/// is needed here at all.
pub async fn install_github_cli(
    on_progress: impl Fn(DependencyInstallProgress),
) -> Result<(), String> {
    let result = install_github_cli_inner(&on_progress).await;
    if let Err(detail) = &result {
        on_progress(progress(
            Dependency::GithubCli,
            InstallPhase::Failed,
            Some(detail.clone()),
            None,
        ));
    }
    result
}

async fn install_github_cli_inner(
    on_progress: &impl Fn(DependencyInstallProgress),
) -> Result<(), String> {
    on_progress(progress(
        Dependency::GithubCli,
        InstallPhase::Downloading,
        None,
        None,
    ));
    let client = allowlisted_client()?;
    let release: GhLatestRelease =
        fetch_json(&client, GITHUB_CLI_RELEASES_API, "GitHub CLI release list")
            .await
            .map_err(|err| fail_detail(&err, GITHUB_CLI_MANUAL_HINT))?;
    let asset =
        find_asset_by_suffix(&release.assets, GITHUB_CLI_ASSET_SUFFIX).ok_or_else(|| {
            fail_detail(
                "Could not find a Windows amd64 GitHub CLI zip in the latest release.",
                GITHUB_CLI_MANUAL_HINT,
            )
        })?;

    let dir = scratch_dir()
        .await
        .map_err(|err| fail_detail(&err, GITHUB_CLI_MANUAL_HINT))?;
    let zip_path = dir.join(safe_file_name(&asset.name));
    download_to_file(
        &client,
        &asset.browser_download_url,
        &zip_path,
        "GitHub CLI download",
    )
    .await
    .map_err(|err| fail_detail(&err, GITHUB_CLI_MANUAL_HINT))?;

    on_progress(progress(
        Dependency::GithubCli,
        InstallPhase::Running,
        None,
        None,
    ));
    let extract_dir = dir.join("extracted");
    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("failed to create an extraction directory: {err}"),
                GITHUB_CLI_MANUAL_HINT,
            )
        })?;
    let zip_path_str = zip_path.to_string_lossy().into_owned();
    let extract_dir_str = extract_dir.to_string_lossy().into_owned();
    let (code, message) = run_process(
        &tar_exe_path(),
        &["-xf", &zip_path_str, "-C", &extract_dir_str],
        PROCESS_TIMEOUT,
    )
    .await
    .map_err(|err| fail_detail(&err, GITHUB_CLI_MANUAL_HINT))?;
    if code != 0 {
        return Err(fail_detail(
            &exit_detail("GitHub CLI archive extraction", code, &message),
            GITHUB_CLI_MANUAL_HINT,
        ));
    }

    let gh_exe = find_file_named(&extract_dir, "gh.exe")
        .await
        .ok_or_else(|| {
            fail_detail(
                "Could not find gh.exe inside the extracted GitHub CLI archive.",
                GITHUB_CLI_MANUAL_HINT,
            )
        })?;

    let local_app_data = env::var("LOCALAPPDATA")
        .map_err(|_| fail_detail("LOCALAPPDATA is not set", GITHUB_CLI_MANUAL_HINT))?;
    let install_path = PathBuf::from(local_app_data)
        .join("refract")
        .join("tools")
        .join("gh")
        .join("gh.exe");
    if let Some(parent) = install_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|err| {
            fail_detail(
                &format!("failed to create the GitHub CLI install directory: {err}"),
                GITHUB_CLI_MANUAL_HINT,
            )
        })?;
    }
    tokio::fs::copy(&gh_exe, &install_path)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("failed to install gh.exe: {err}"),
                GITHUB_CLI_MANUAL_HINT,
            )
        })?;

    on_progress(progress(
        Dependency::GithubCli,
        InstallPhase::Done,
        None,
        None,
    ));
    Ok(())
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
        let found = find_asset_by_suffix(&assets, GITHUB_CLI_ASSET_SUFFIX);
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
        let found = find_asset_by_suffix(&assets, GIT_ASSET_SUFFIX);
        assert_eq!(
            found.map(|a| a.name.as_str()),
            Some("Git-2.47.0-64-bit.exe")
        );
    }

    #[test]
    fn find_asset_by_suffix_returns_none_when_nothing_matches() {
        let assets = vec![asset("gh_2.63.0_macOS_amd64.zip")];
        assert!(find_asset_by_suffix(&assets, GITHUB_CLI_ASSET_SUFFIX).is_none());
    }

    #[test]
    fn fail_detail_appends_the_manual_hint() {
        let detail = fail_detail("installer exited with code 1", GIT_MANUAL_HINT);
        assert!(detail.starts_with("installer exited with code 1"));
        assert!(detail.ends_with(GIT_MANUAL_HINT));
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
