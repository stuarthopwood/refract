// Install-on-quit mechanism (spec 006 FR-015, FR-016, FR-018, research.md decision 5): when a
// verified installer is waiting (`phase: 'downloaded'`) and Refract quits normally, main spawns a
// short-lived helper -- still inside Refract's own kill-on-close Job Object
// (`process::job_object.rs`) -- whose only job is to hand the real wait-then-install work to a
// NEW process created through WMI (`Invoke-CimMethod -ClassName Win32_Process -MethodName
// Create`). WMI's own provider host (`wmiprvse.exe`), not this helper, is what actually calls
// Win32 `CreateProcess` for that new process, and Windows only auto-assigns a freshly-created
// process to its PARENT's job(s) -- `wmiprvse.exe` is never a member of Refract's job, so the
// wait-then-install process it creates is never assigned to it either, and survives Refract's
// exit intact (quality-gate remediation, CRITICAL: `spawn(..., { detached: true })`'s plain
// `DETACHED_PROCESS`/`CREATE_NEW_PROCESS_GROUP` does nothing to escape job membership, so the old
// helper was being killed by Windows the instant Refract's own process exited, before it ever
// reached `Start-Process ... /S`).
//
// Deliberately NOT done by adding `JOB_OBJECT_LIMIT_BREAKAWAY_OK`/`CREATE_BREAKAWAY_FROM_JOB` to
// the job itself (the other fix the report offered): that would let ANY process opt out of the
// job, including a spawned `omp` subprocess, which must stay killable -- that is the whole point
// of `process/job_object.rs`. The WMI hand-off needs no change to the job's own flags at all
// (smallest blast radius: zero changes to `job_object.rs`).
//
// Refract does not relaunch itself; the developer's next launch (from the unchanged Desktop/Start
// Menu shortcut) is the new version.
//
// UNVERIFIED: gate T004/T011 pending -- this has not yet been confirmed on a real quit-then-
// relaunch against a packaged build (docs/spike/FINDINGS.md item 12 only verified the job's own
// kill-on-close guarantee, not this WMI breakaway).
//
// Ported from `src/main/update/installOnQuit.ts`'s `verifyInstallerBeforeQuit`,
// `scheduleInstallOnQuit`, `resolveInstallingState` (git show
// origin/spec-006-impl:src/main/update/installOnQuit.ts).

use std::path::{Path, PathBuf};

use tokio::process::Command;

use super::checksum::{checksum_matches, hex_digest_file};
use super::state::{UpdatePhase, UpdateState, UpdateStateStore};

/// Windows-only: `CREATE_NO_WINDOW`, the same flag `git/git.rs` uses -- no console window flashes
/// for the short-lived in-job PowerShell helper this spawns.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Quality-gate remediation (LOW, security): re-verifies a `downloaded` installer immediately
/// before scheduling it, rather than trusting `updateState.json`'s possibly-stale `installerPath`
/// at face value -- the file must still live directly inside `updates_dir` (`<userData>/updates`,
/// never anywhere a stale/tampered `installerPath` could have redirected it to) and its SHA-256
/// must still match the `.sha256` sibling file (not a new `UpdateChecker` download, that sibling
/// file is this app's one persisted copy of "the expected hash").
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

    Ok(())
}

/// Spawns the short-lived in-job PowerShell helper that hands the real wait-then-install process
/// off to a WMI-created, out-of-job wait-then-install process, and resolves once this hand-off
/// has been confirmed (via `Win32_Process.Create`'s own `ReturnValue`), not merely once the
/// helper process was launched -- a silent hand-off failure must never be mistaken for a
/// scheduled install. The caller persists `phase: Installing` only after this resolves
/// successfully.
pub async fn schedule_install_on_quit(
    installer_path: &Path,
    refract_pid: u32,
) -> Result<(), String> {
    let pwsh = resolve_powershell();
    let pwsh_str = pwsh.to_string_lossy();

    // Quality-gate remediation (LOW, security): `$env:REFRACT_INSTALLER_PATH` is left as literal,
    // UNEXPANDED text in this constant -- it is resolved by the WMI-created process from ITS OWN
    // environment (set below via `Win32_ProcessStartup.EnvironmentVariables`, never spliced into
    // any script as a string). The installer's filename comes from a GitHub release asset name
    // (less trusted than Refract's own fixed constants), and PowerShell's tokenizer also treats
    // U+2018-U+201B as quote characters, which a doubled-ASCII-quote escape alone would not
    // defend against. `refract_pid` (a plain integer from `std::process::id()`, never caller
    // input) and `pwsh` (a `which`/fixed-path-resolved, equally trusted system path) are
    // interpolated directly -- neither is a shell-injection boundary, and `pwsh` is still
    // defensively single-quote-escaped below along with everything else in `inner_command_line`.
    // Gate finding (PR #829 round 1, Medium): `/UPDATE` tells the generated installer this is an
    // upgrade over an existing install (`installer.nsi`'s own `PageLeaveReinstall`/`UpdateMode`
    // handling) -- without it, every update silently re-creates the Desktop/Start-menu shortcuts
    // and re-runs the WebView2 bootstrapper step on each quit-then-install cycle.
    let inner_command = format!(
        "Wait-Process -Id {refract_pid} -ErrorAction SilentlyContinue; Start-Process -FilePath $env:REFRACT_INSTALLER_PATH -ArgumentList '/S','/UPDATE'"
    );
    let inner_command_line =
        format!("\"{pwsh_str}\" -NoProfile -NonInteractive -WindowStyle Hidden -Command \"{inner_command}\"");
    let outer_script = [
        format!("$inner = '{}'", escape_single_quoted(&inner_command_line)),
        // Forwards every env var this (outer, in-job) process already has -- including
        // `REFRACT_INSTALLER_PATH`, set below via `Command::env` -- to the WMI-created process.
        // `Win32_ProcessStartup.EnvironmentVariables`, when set at all, REPLACES rather than
        // extends the new process's environment, so this reads the full table rather than
        // listing only the one new variable, to avoid silently dropping `SystemRoot`/`PATH`/etc.
        // the inner `pwsh.exe` itself may need.
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

/// Resolves a persisted `Installing` phase left over from the previous run (FR-018); called once
/// at startup before the automatic update check. A phase other than `Installing` means the
/// install-on-quit helper never got to run (or there was nothing to resolve) and is reported as a
/// failure rather than ever leaving an unfinished update looking like success -- this only ever
/// resolves that one specific leftover state, and is left untouched (no write) otherwise.
pub async fn resolve_installing_state(
    store: &mut UpdateStateStore,
    installed_version: &str,
) -> UpdateState {
    let state = store.get();
    if state.phase != UpdatePhase::Installing {
        return state;
    }

    // A version match means the install-on-quit helper succeeded, a mismatch (or the helper
    // never got to run) is reported as a failure.
    let version_matches = state
        .available_version
        .as_deref()
        .is_some_and(|available| available == installed_version);

    if version_matches {
        // Quality-gate remediation (LOW "a successful install leaves the old installer on
        // disk"): on a version match, the installer and its `.sha256` sibling (about 146MB
        // together) are deleted -- they already did their job and are never needed again. Two
        // individual file deletes, only ever the exact paths this same `state.installerPath`
        // already names, never a directory.
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

/// Resolves PowerShell: `pwsh` (PowerShell 7+) if it is on `PATH`, else the fixed, always-present
/// Windows PowerShell 5.1 path -- infallible, since the fallback exists on every supported
/// Windows target.
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

/// `<installer>.sha256`: appended to the whole path (including the `.exe` extension), never
/// replacing it -- the same sibling-file naming `installer.rs`'s own `UpdateInstaller.ts` port
/// uses.
fn sha256_sibling(installer_path: &Path) -> PathBuf {
    let mut name = installer_path.as_os_str().to_os_string();
    name.push(".sha256");
    PathBuf::from(name)
}

/// Factored out so it can be unit-tested without touching the filesystem: `installer_path` must
/// live directly inside `updates_dir`, never one level deeper/shallower or in an unrelated
/// directory a stale/tampered `installerPath` could otherwise redirect verification to.
fn installer_is_directly_inside(installer_path: &Path, updates_dir: &Path) -> bool {
    installer_path.parent() == Some(updates_dir)
}

/// PowerShell single-quoted strings escape an embedded `'` by doubling it. Port of
/// `installOnQuit.ts`'s own `escapeSingleQuoted`.
fn escape_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{escape_single_quoted, installer_is_directly_inside};

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
