// No-admin installs of Git, omp, and gh. gh uses the zip, not the MSI, to avoid an elevation prompt.
// Git always reports `restart_required: true`; the resolver cache cannot be primed in-process.

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::checksum::checksum_matches;
use super::dependency_install_http::{
    allowlisted_client, assert_allowed_url, download_to_file, exit_detail, fail_detail, fetch_json,
    find_asset_by_suffix, find_file_named, resolve_powershell, run_process, safe_file_name,
    scratch_dir, GhLatestRelease, FETCH_JSON_TIMEOUT,
};
use crate::process::executables::{prime_omp_cache, tar_exe_path};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const GIT_RELEASES_API: &str = "https://api.github.com/repos/git-for-windows/git/releases/latest";
const GITHUB_CLI_RELEASES_API: &str = "https://api.github.com/repos/cli/cli/releases/latest";
const GIT_ASSET_SUFFIX: &str = "-64-bit.exe";
const GITHUB_CLI_ASSET_SUFFIX: &str = "_windows_amd64.zip";

/// Pinned omp version, passed to the install script's `-Ref` parameter.
const OMP_PINNED_TAG: &str = "v18.10.1";

/// Commit pin, not the tag: a tag can be force-moved, a commit sha cannot.
const OMP_INSTALL_SCRIPT_COMMIT: &str = "5d0aaffaf1f987503ce129a642fb6e30339615af";
/// Checked on every fetch before the script reaches PowerShell.
const OMP_INSTALL_SCRIPT_SHA256: &str =
    "86e91d6bac0e66c700662757c71e54cf551fa8c8a82fdd370043348b1d8df1fb";
const OMP_INSTALL_SCRIPT_MAX_BYTES: usize = 256 * 1024;

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

/// Runs the latest Git for Windows installer silently, per-user.
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

/// Runs omp's install script at the pinned tag; only `running` is reported.
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
    // Built only from fixed constants; the script is SHA-256 verified before it runs.
    let script_url = format!(
        "https://raw.githubusercontent.com/can1357/oh-my-pi/{OMP_INSTALL_SCRIPT_COMMIT}/scripts/install.ps1"
    );
    let script_bytes = fetch_omp_install_script(&script_url)
        .await
        .map_err(|err| fail_detail(&err, OMP_MANUAL_HINT))?;

    let dir = scratch_dir()
        .await
        .map_err(|err| fail_detail(&err, OMP_MANUAL_HINT))?;
    let script_path = dir.join("install.ps1");
    // `create_new` refuses to overwrite; a collision would be a real bug.
    let mut script_file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script_path)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("could not create the omp install script file: {err}"),
                OMP_MANUAL_HINT,
            )
        })?;
    tokio::io::AsyncWriteExt::write_all(&mut script_file, &script_bytes)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("could not write omp install script: {err}"),
                OMP_MANUAL_HINT,
            )
        })?;
    // Sync before `pwsh` reads the file so it never sees a partial write.
    tokio::io::AsyncWriteExt::flush(&mut script_file)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("could not flush omp install script: {err}"),
                OMP_MANUAL_HINT,
            )
        })?;
    script_file.sync_all().await.map_err(|err| {
        fail_detail(
            &format!("could not sync omp install script: {err}"),
            OMP_MANUAL_HINT,
        )
    })?;
    drop(script_file);
    let script_path_str = script_path.to_string_lossy().into_owned();

    let (code, message) = run_process(
        &pwsh,
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path_str,
            "-Binary",
            "-Ref",
            OMP_PINNED_TAG,
        ],
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

    // The script's User-scope PATH write is invisible to this process; prime the cache here.
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

/// Fetches the script and verifies it against `OMP_INSTALL_SCRIPT_SHA256`.
async fn fetch_omp_install_script(script_url: &str) -> Result<Vec<u8>, String> {
    let url = assert_allowed_url(
        script_url,
        &["raw.githubusercontent.com"],
        "omp install script",
    )?;
    let client = allowlisted_client()?;
    let mut response = client
        .get(url)
        .header("User-Agent", "refract-dependency-install")
        .timeout(FETCH_JSON_TIMEOUT)
        .send()
        .await
        .map_err(|err| format!("omp install script request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "omp install script responded with HTTP {}",
            response.status()
        ));
    }
    // Enforced on the running total too, so a missing or lying `Content-Length` cannot bypass it.
    if response
        .content_length()
        .is_some_and(|len| len > OMP_INSTALL_SCRIPT_MAX_BYTES as u64)
    {
        return Err(format!(
            "omp install script response is larger than the {OMP_INSTALL_SCRIPT_MAX_BYTES}-byte cap"
        ));
    }
    // Streamed, so an oversized body fails before it is buffered.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("omp install script download failed: {err}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > OMP_INSTALL_SCRIPT_MAX_BYTES {
            return Err(format!(
                "omp install script body is larger than the {OMP_INSTALL_SCRIPT_MAX_BYTES}-byte cap"
            ));
        }
    }
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if !checksum_matches(&actual, OMP_INSTALL_SCRIPT_SHA256) {
        return Err(format!(
            "omp install script checksum mismatch: expected {OMP_INSTALL_SCRIPT_SHA256}, got {actual}"
        ));
    }
    Ok(bytes)
}

/// Installs the portable GitHub CLI zip to the path `gh_client.rs` checks first.
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
