// WMI puts the installer helper outside Refract's kill-on-close job; leave the job flags alone so `omp` stays killable.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use super::checker::compare_versions;
use super::checksum::{checksum_matches, hex_digest_file};
use super::signature::{verify_installer_signature, SIGNATURE_REJECTED_MESSAGE};
use super::state::{UpdatePhase, UpdateState, UpdateStateStore};

/// Hides the console window of the short-lived PowerShell helper.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Bounds the signature check so a stalled `WinVerifyTrust` cannot hang quit. Fails closed.
const SIGNATURE_VERIFY_TIMEOUT: Duration = Duration::from_secs(10);

/// Re-verifies a `downloaded` installer before scheduling it: it must sit directly in
/// `updates_dir`, match its `.sha256` sibling, and still pass the Authenticode check.
pub async fn verify_installer_before_quit(
    installer_path: &Path,
    updates_dir: &Path,
) -> Result<(), String> {
    if !installer_is_directly_inside(installer_path, updates_dir) {
        return Err(format!(
            "installer path {} is not directly inside {}",
            installer_path.display(),
            updates_dir.display()
        ));
    }

    let checksum_path = sha256_sibling(installer_path);
    let expected = tokio::fs::read_to_string(&checksum_path)
        .await
        .map_err(|err| format!("could not read {}: {err}", checksum_path.display()))?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let actual = hex_digest_file(installer_path).await?;

    if !checksum_matches(&actual, &expected) {
        return Err(format!(
            "{} no longer matches its published checksum",
            installer_path.display()
        ));
    }

    match tokio::time::timeout(
        SIGNATURE_VERIFY_TIMEOUT,
        verify_installer_signature(installer_path),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            // Same constant message as any rejected signature, so a timeout is not a distinct oracle.
            log::error!(
                "signature verification of {} timed out after {SIGNATURE_VERIFY_TIMEOUT:?}",
                installer_path.display()
            );
            return Err(SIGNATURE_REJECTED_MESSAGE.to_string());
        }
    }

    Ok(())
}

/// Spawns the helper that hands the install off to a WMI-created process.
pub async fn schedule_install_on_quit(
    installer_path: &Path,
    refract_pid: u32,
    relaunch_path: Option<&Path>,
) -> Result<(), String> {
    let pwsh = resolve_powershell();
    let pwsh_str = pwsh.to_string_lossy();

    // `$env:` names stay unexpanded so the installer path is never spliced into the script.
    let inner_command = if relaunch_path.is_some() {
        format!(
            "Wait-Process -Id {refract_pid} -ErrorAction SilentlyContinue; Start-Process -FilePath $env:REFRACT_INSTALLER_PATH -ArgumentList '/S','/UPDATE' -Wait; Start-Process -FilePath $env:REFRACT_RELAUNCH_PATH"
        )
    } else {
        format!(
            "Wait-Process -Id {refract_pid} -ErrorAction SilentlyContinue; Start-Process -FilePath $env:REFRACT_INSTALLER_PATH -ArgumentList '/S','/UPDATE'"
        )
    };
    let inner_command_line =
        format!("\"{pwsh_str}\" -NoProfile -NonInteractive -WindowStyle Hidden -Command \"{inner_command}\"");
    let outer_script = [
        format!("$inner = '{}'", escape_single_quoted(&inner_command_line)),
        // WMI replaces the child's env rather than extending it, so forward `SystemRoot`/`PATH` too.
        "$envList = [Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { \"$($_.Key)=$($_.Value)\" }".to_string(),
        "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $envList }".to_string(),
        "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $inner; ProcessStartupInformation = $startup }".to_string(),
        "if ($result.ReturnValue -ne 0) { Write-Error \"Win32_Process.Create failed with ReturnValue $($result.ReturnValue)\"; exit 1 }".to_string(),
    ]
    .join("; ");

    let mut command = Command::new(&pwsh);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &outer_script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .env("REFRACT_INSTALLER_PATH", installer_path);
    if let Some(relaunch_path) = relaunch_path {
        command.env("REFRACT_RELAUNCH_PATH", relaunch_path);
    }

    let output = command.output().await.map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    if detail.is_empty() {
        Err(format!("install-on-quit hand-off failed (exit {code})."))
    } else {
        Err(format!(
            "install-on-quit hand-off failed (exit {code}). {detail}"
        ))
    }
}

/// Resolves a phase left behind by a run that quit or crashed mid-flight.
pub async fn resolve_startup_state(
    store: &mut UpdateStateStore,
    installed_version: &str,
) -> UpdateState {
    let state = store.get();
    match state.phase {
        UpdatePhase::Installing => {
            // A version mismatch means the helper never installed the update.
            let version_matches = state
                .available_version
                .as_deref()
                .is_some_and(|available| available == installed_version);

            if version_matches {
                // Delete only the exact installer and sibling paths, never a directory.
                if let Some(installer_path) = state.installer_path.as_deref() {
                    let _ = tokio::fs::remove_file(installer_path).await;
                    let _ = tokio::fs::remove_file(sha256_sibling(Path::new(installer_path))).await;
                }
                return store
                    .update(|s| {
                        s.phase = UpdatePhase::Idle;
                        s.installer_path = None;
                        s.last_error = None;
                    })
                    .await;
            }

            store
                .update(|s| {
                    s.phase = UpdatePhase::Failed;
                    s.last_error = Some(
                        "The update did not finish installing. The previous version is still running."
                            .to_string(),
                    );
                })
                .await
        }
        UpdatePhase::Downloading => {
            store
                .update(|s| {
                    s.phase = UpdatePhase::Failed;
                    s.last_error = Some("Download was interrupted.".to_string());
                })
                .await
        }
        UpdatePhase::Checking => {
            store
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                })
                .await
        }
        UpdatePhase::Downloaded => {
            // Drop an installer for a version already installed, so it stops prompting "Update now".
            let stale = state
                .available_version
                .as_deref()
                .is_some_and(|available| compare_versions(available, installed_version) <= 0);
            if !stale {
                return state;
            }
            if let Some(installer_path) = state.installer_path.as_deref() {
                let _ = tokio::fs::remove_file(installer_path).await;
                let _ = tokio::fs::remove_file(sha256_sibling(Path::new(installer_path))).await;
            }
            store
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                    s.installer_path = None;
                    s.available_version = None;
                    s.notes_url = None;
                })
                .await
        }
        _ => state,
    }
}

/// Prefers `pwsh` on `PATH`, else the always-present Windows PowerShell 5.1.
fn resolve_powershell() -> PathBuf {
    if let Ok(path) = which::which_global("pwsh") {
        return path;
    }
    let system_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// `<installer>.sha256`, appended to the full path so the `.exe` is kept.
fn sha256_sibling(installer_path: &Path) -> PathBuf {
    let mut name = installer_path.as_os_str().to_os_string();
    name.push(".sha256");
    PathBuf::from(name)
}

/// Rejects a tampered `installerPath` that points outside `updates_dir`.
fn installer_is_directly_inside(installer_path: &Path, updates_dir: &Path) -> bool {
    installer_path.parent() == Some(updates_dir)
}

/// PowerShell single-quoted strings escape an embedded `'` by doubling it.
fn escape_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{escape_single_quoted, installer_is_directly_inside, resolve_startup_state};
    use crate::updates::state::{UpdatePhase, UpdateStateStore};

    async fn store_with_phase(phase: UpdatePhase) -> (UpdateStateStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "refract-tauri-installonquit-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        let mut store = UpdateStateStore::open(&dir).await;
        store.update(|s| s.phase = phase).await;
        (store, dir)
    }

    #[tokio::test]
    async fn resolve_startup_state_maps_a_leftover_downloading_phase_to_failed() {
        let (mut store, dir) = store_with_phase(UpdatePhase::Downloading).await;
        let resolved = resolve_startup_state(&mut store, "1.0.0").await;
        assert_eq!(resolved.phase, UpdatePhase::Failed);
        assert_eq!(
            resolved.last_error.as_deref(),
            Some("Download was interrupted.")
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn resolve_startup_state_maps_a_leftover_checking_phase_to_idle() {
        let (mut store, dir) = store_with_phase(UpdatePhase::Checking).await;
        let resolved = resolve_startup_state(&mut store, "1.0.0").await;
        assert_eq!(resolved.phase, UpdatePhase::Idle);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn resolve_startup_state_clears_a_downloaded_phase_whose_version_is_installed() {
        let (mut store, dir) = store_with_phase(UpdatePhase::Downloaded).await;
        store
            .update(|s| s.available_version = Some("1.0.0".to_string()))
            .await;
        let resolved = resolve_startup_state(&mut store, "1.0.0").await;
        assert_eq!(resolved.phase, UpdatePhase::Idle);
        assert_eq!(resolved.available_version, None);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn resolve_startup_state_keeps_a_downloaded_phase_for_a_newer_version() {
        let (mut store, dir) = store_with_phase(UpdatePhase::Downloaded).await;
        store
            .update(|s| s.available_version = Some("1.1.0".to_string()))
            .await;
        let resolved = resolve_startup_state(&mut store, "1.0.0").await;
        assert_eq!(resolved.phase, UpdatePhase::Downloaded);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn resolve_startup_state_leaves_idle_untouched() {
        let (mut store, dir) = store_with_phase(UpdatePhase::Idle).await;
        let resolved = resolve_startup_state(&mut store, "1.0.0").await;
        assert_eq!(resolved.phase, UpdatePhase::Idle);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn escapes_every_embedded_single_quote() {
        assert_eq!(escape_single_quoted("it's a 'test'"), "it''s a ''test''");
        assert_eq!(escape_single_quoted("no quotes here"), "no quotes here");
    }

    #[test]
    fn accepts_installer_directly_inside_updates_dir() {
        assert!(installer_is_directly_inside(
            Path::new("C:/Users/dev/AppData/Roaming/Refract/updates/Refract-setup.exe"),
            Path::new("C:/Users/dev/AppData/Roaming/Refract/updates"),
        ));
    }

    #[test]
    fn rejects_installer_outside_updates_dir() {
        assert!(!installer_is_directly_inside(
            Path::new("C:/Users/dev/Desktop/Refract-setup.exe"),
            Path::new("C:/Users/dev/AppData/Roaming/Refract/updates"),
        ));
        assert!(!installer_is_directly_inside(
            Path::new("C:/Users/dev/AppData/Roaming/Refract/updates/nested/Refract-setup.exe"),
            Path::new("C:/Users/dev/AppData/Roaming/Refract/updates"),
        ));
    }
}
