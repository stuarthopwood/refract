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
/// `updates_dir`, match its `.sha256` sibling, and still pass the Authenticode check. Returns the
/// verified digest so the helper can re-check it after the quit wait.
pub async fn verify_installer_before_quit(
    installer_path: &Path,
    updates_dir: &Path,
) -> Result<String, String> {
    if !installer_is_directly_inside(installer_path, updates_dir) {
        return Err(format!(
            "installer path {} is not directly inside {}",
            installer_path.display(),
            updates_dir.display()
        ));
    }
    reject_redirected_installer(installer_path, updates_dir).await?;

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

    Ok(actual)
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

// A junction or symlink in the path would let the lexical check pass for a file elsewhere.
async fn reject_redirected_installer(
    installer_path: &Path,
    updates_dir: &Path,
) -> Result<(), String> {
    let redirected = || {
        format!(
            "installer path {} resolves outside {}",
            installer_path.display(),
            updates_dir.display()
        )
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let dir_meta = tokio::fs::symlink_metadata(updates_dir)
            .await
            .map_err(|err| format!("could not inspect {}: {err}", updates_dir.display()))?;
        if dir_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "updates directory {} is a junction or symlink",
                updates_dir.display()
            ));
        }
    }
    let real_dir = tokio::fs::canonicalize(updates_dir)
        .await
        .map_err(|err| format!("could not resolve {}: {err}", updates_dir.display()))?;
    let real_file = tokio::fs::canonicalize(installer_path)
        .await
        .map_err(|err| format!("could not resolve {}: {err}", installer_path.display()))?;
    if real_file.parent() != Some(real_dir.as_path()) {
        return Err(redirected());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let meta = tokio::fs::symlink_metadata(installer_path)
            .await
            .map_err(|err| err.to_string())?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(redirected());
        }
    }
    Ok(())
}

/// Spawns the helper that hands the install off to a WMI-created process.
pub async fn schedule_install_on_quit(
    installer_path: &Path,
    verified_sha256: &str,
    refract_pid: u32,
    relaunch_path: Option<&Path>,
) -> Result<(), String> {
    let pwsh = resolve_powershell();
    let pwsh_str = pwsh.to_string_lossy();
    let log_path = install_log_path(installer_path);
    // A fresh header means a stale result from an earlier attempt is never read as this one's.
    let header = format!(
        "{} scheduled: installer={} pid={refract_pid}\n",
        unix_seconds(),
        installer_path.display()
    );
    write_log_header(&log_path, &header)
        .await
        .map_err(|err| format!("could not write {}: {err}", log_path.display()))?;

    // The script is fixed text passed as -EncodedCommand; every path reaches it through `$env:` only.
    let encoded = encode_powershell_command(INSTALL_HELPER_SCRIPT);
    let inner_command_line = format!(
        "\"{pwsh_str}\" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}"
    );
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
        .env("REFRACT_INSTALLER_PATH", installer_path)
        .env("REFRACT_INSTALLER_SHA256", verified_sha256)
        .env("REFRACT_INSTALL_LOG", &log_path)
        .env("REFRACT_WAIT_PID", refract_pid.to_string());
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
    append_log(
        &log_path,
        &format!(
            "{} hand-off failed: exit={code} stdout={:?} stderr={:?}\n",
            unix_seconds(),
            String::from_utf8_lossy(&output.stdout).trim(),
            detail
        ),
    )
    .await;
    if detail.is_empty() {
        Err(format!("install-on-quit hand-off failed (exit {code})."))
    } else {
        Err(format!(
            "install-on-quit hand-off failed (exit {code}). {detail}"
        ))
    }
}

/// Fixed helper text; the PID, installer, relaunch target and log path arrive only as env vars.
/// The installer's exit code decides success; the old build is relaunched on failure, the new one on success.
const INSTALL_HELPER_SCRIPT: &str = r#"
$log = $env:REFRACT_INSTALL_LOG
function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $m) -Encoding UTF8 }
$code = [int]::MinValue
try {
  Wait-Process -Id ([int]$env:REFRACT_WAIT_PID) -ErrorAction SilentlyContinue
  $hash = (Get-FileHash -LiteralPath $env:REFRACT_INSTALLER_PATH -Algorithm SHA256 -ErrorAction Stop).Hash
  # -ne is case-insensitive, which is right for hex digests; do not swap it for -cne. A swap in the window before Start-Process is not closable from script.
  if ($hash -ne $env:REFRACT_INSTALLER_SHA256) { throw 'installer changed after it was verified' }
  Log 'installer starting'
  $out = $log + '.out'; $err = $log + '.err'
  $p = Start-Process -FilePath $env:REFRACT_INSTALLER_PATH -ArgumentList '/S','/UPDATE' -Wait -PassThru -ErrorAction Stop -RedirectStandardOutput $out -RedirectStandardError $err
  $code = $p.ExitCode
  foreach ($f in @($out, $err)) { if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f | ForEach-Object { Log ('installer output: ' + $_) }; Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue } }
} catch { Log ('error: ' + $_.Exception.Message) }
Log ('result: exit=' + $code)
if ($env:REFRACT_RELAUNCH_PATH) {
  try { Start-Process -FilePath $env:REFRACT_RELAUNCH_PATH -ErrorAction Stop; Log 'relaunched' } catch { Log ('relaunch error: ' + $_.Exception.Message) }
}
"#;

/// `install.log` beside the installer, written by Rust and by the helper.
fn install_log_path(installer_path: &Path) -> PathBuf {
    installer_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("install.log")
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `-EncodedCommand` takes base64 of UTF-16LE, so no quoting of the script is ever needed.
fn encode_powershell_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// Opens the log itself rather than a link planted at its name.
fn no_follow(options: &mut tokio::fs::OpenOptions) -> &mut tokio::fs::OpenOptions {
    #[cfg(windows)]
    {
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}

async fn reject_linked_log(log_path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = tokio::fs::symlink_metadata(log_path).await {
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(std::io::Error::other("install.log is a link"));
            }
        }
    }
    let _ = log_path;
    Ok(())
}

async fn write_log_header(log_path: &Path, header: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    reject_linked_log(log_path).await?;
    let mut file = no_follow(
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true),
    )
    .open(log_path)
    .await?;
    file.write_all(header.as_bytes()).await
}

async fn append_log(log_path: &Path, line: &str) {
    use tokio::io::AsyncWriteExt;
    if reject_linked_log(log_path).await.is_err() {
        return;
    }
    let opened = no_follow(tokio::fs::OpenOptions::new().create(true).append(true))
        .open(log_path)
        .await;
    if let Ok(mut file) = opened {
        let _ = file.write_all(line.as_bytes()).await;
    }
}

/// Logged as the exit when the helper never ran the installer (a real installer can exit -1).
const HELPER_NOT_STARTED: i64 = i32::MIN as i64;

/// The last `result: exit=N` the helper logged, if any; the marker must start the line's message.
fn parse_helper_exit_code(log: &str) -> Option<i64> {
    log.lines().rev().find_map(|line| {
        let (_, message) = line.split_once(' ')?;
        message.strip_prefix("result: exit=")?.trim().parse().ok()
    })
}

/// Cause-bearing `lastError` for an update that never took effect, read from the helper's log.
async fn install_failure_message(log_path: Option<&Path>) -> String {
    let suffix = "The previous version is still running.";
    let Some(log_path) = log_path else {
        return format!("The update did not finish installing. {suffix}");
    };
    let log = tokio::fs::read_to_string(log_path).await.ok();
    let location = format!("Details: {}", log_path.display());
    match log.as_deref().and_then(parse_helper_exit_code) {
        Some(0) => format!(
            "The installer reported success (exit code 0) but the version did not change. {suffix} {location}"
        ),
        Some(HELPER_NOT_STARTED) => format!(
            "The update installer could not be started. {suffix} {location}"
        ),
        Some(code) => format!(
            "The update failed to install (installer exit code {code}). {suffix} {location}"
        ),
        None if log.is_some() => format!(
            "The update did not finish installing and the install helper recorded no result; it may not have run. {suffix} {location}"
        ),
        None => format!("The update did not finish installing. {suffix}"),
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

            let log_path = state
                .installer_path
                .as_deref()
                .map(|p| install_log_path(Path::new(p)));
            let message = install_failure_message(log_path.as_deref()).await;
            store
                .update(|s| {
                    s.phase = UpdatePhase::Failed;
                    s.last_error = Some(message);
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

/// Windows PowerShell 5.1 from System32 only: a `pwsh` found on `PATH` is user-writable ground
/// for the process that installs an update.
fn resolve_powershell() -> PathBuf {
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
        let dir = crate::test_scratch::path(format!(
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
