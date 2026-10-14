// Port of `src/main/dependencyInstall.ts` (lane R11b, issue #794): installs Git for Windows, omp,
// and the GitHub CLI from a first-run readiness checklist Install action, each as a single
// no-admin, unattended background install reporting progress through
// `DependencyInstallProgress` (contracts/ipc.md, data-model.md). Generic HTTP/process/scratch-dir
// plumbing lives in the sibling `dependency_install_http` module (`AGENTS.md` "No god files");
// this file is the three dependency-specific install flows plus their own wire types.
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

/// Point-in-time pin, confirmed current against this issue's own probe machine
/// (specs/016-tauri-rust-build/installer-probes.md). Passed to the install script's own `-Ref`
/// parameter (the omp version to install) -- this is a version identifier the script's API
/// expects, not a trust boundary. If a different version is needed, update this one constant.
const OMP_PINNED_TAG: &str = "v18.10.1";

/// Gate hardening (security, supply-chain): the install SCRIPT itself is fetched from this exact
/// commit, never the `v18.10.1` tag ref -- a git tag can be force-moved by whoever controls the
/// upstream repo, silently changing what this already-reviewed script does on every Refract
/// install from then on; a commit sha is content-addressed and cannot be redefined. Resolved once
/// via `gh api repos/can1357/oh-my-pi/git/refs/tags/v18.10.1` (confirmed byte-identical to the
/// tag URL at resolution time); update both this and `OMP_INSTALL_SCRIPT_SHA256` together if the
/// pinned omp version above ever changes.
const OMP_INSTALL_SCRIPT_COMMIT: &str = "5d0aaffaf1f987503ce129a642fb6e30339615af";
/// SHA-256 of the script at the commit above, computed once at pin time. `install_omp_inner`
/// verifies every fetch against this before ever handing the content to PowerShell -- the first,
/// not the last, line of defence; the commit pin above should already make a mismatch impossible
/// in normal operation, but defence in depth costs nothing here.
const OMP_INSTALL_SCRIPT_SHA256: &str =
    "86e91d6bac0e66c700662757c71e54cf551fa8c8a82fdd370043348b1d8df1fb";

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
    // supply-chain risk). The script is fetched by COMMIT, not tag (`OMP_INSTALL_SCRIPT_COMMIT`'s
    // own doc comment), and its content is verified against a pinned SHA-256 before it is ever
    // written to disk or handed to PowerShell -- unlike the old inline `irm {url} | iex` shape,
    // nothing here executes unverified bytes.
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
    tokio::fs::write(&script_path, &script_bytes)
        .await
        .map_err(|err| {
            fail_detail(
                &format!("could not write omp install script: {err}"),
                OMP_MANUAL_HINT,
            )
        })?;
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

/// Fetches `script_url` (already validated as commit-addressed `raw.githubusercontent.com`) and
/// verifies its content against `OMP_INSTALL_SCRIPT_SHA256` before returning it -- the caller
/// never writes or executes a byte of this response until it has passed this check.
async fn fetch_omp_install_script(script_url: &str) -> Result<Vec<u8>, String> {
    let url = assert_allowed_url(
        script_url,
        &["raw.githubusercontent.com"],
        "omp install script",
    )?;
    let client = allowlisted_client()?;
    let response = client
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
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("omp install script download failed: {err}"))?
        .to_vec();
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
