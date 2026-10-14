// `ImportLock`: split out of `import.rs` to stay under the file-size cap. See that file's own
// module doc comment for the full "why a process-lifetime, PID-owned lock" reasoning; this file
// is just the mechanism.
//
// Gate-round-3 hardening: `acquire` is bounded (one steal attempt, never an unbounded retry
// loop; any create error other than "already exists" is `Failed`, not silently retried forever).
// The lock file is written atomically (temp file + `hard_link`, the same create-new pattern
// `import.rs`'s own `import_if_absent` uses, so a reader never observes an empty file mid-write)
// and carries the owner's process CREATION TIME alongside its pid (`GetProcessTimes`), so a
// reused pid is never mistaken for the original owner. An empty or unparseable lock (should not
// happen given the atomic write, but defensive) falls back to an mtime-based staleness test
// ("a few minutes") instead of being treated as unconditionally live or unconditionally dead.
// `Drop` removes the file only if it still holds THIS process's own pid.
//
// Gate-round-4 (PR #833 follow-up): a failed `GetProcessTimes` on this process's own creation
// time now propagates as `Failed` instead of being swallowed into a fabricated tick-0 value
// (which would have made every future launch's `process_matches` compare against made-up data).
// The single steal attempt re-reads the lock's content immediately before removing it and only
// removes if unchanged since the abandonment check -- if another launch already stole/rewrote
// it in between, this launch backs off to `AlreadyRunning` instead of deleting that fresh lock.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ImportOutcome;

const LOCK_FILE: &str = "electron-import.lock";
const MTIME_STALE_AFTER_MILLIS: u128 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockOwner {
    pid: u32,
    created_at_ticks: u64,
}

enum LockCreate {
    Created,
    Exists,
    Error(std::io::Error),
}

pub struct ImportLock {
    path: PathBuf,
}

impl ImportLock {
    pub async fn acquire(data_dir: &Path) -> Result<Self, ImportOutcome> {
        let path = data_dir.join(LOCK_FILE);
        let created_at_ticks = current_process_created_at().map_err(|err| {
            ImportOutcome::Failed(format!("reading this process's own creation time: {err}"))
        })?;
        let owner = LockOwner {
            pid: std::process::id(),
            created_at_ticks,
        };

        match try_create_lock(&path, &owner).await {
            LockCreate::Created => return Ok(Self { path }),
            LockCreate::Exists => {}
            LockCreate::Error(err) => {
                return Err(ImportOutcome::Failed(format!("creating {path:?}: {err}")))
            }
        }

        // Exactly one steal attempt: a live owner means `AlreadyRunning`; an abandoned lock is
        // removed and recreated once, and if that loses a race to a third process, this launch
        // also backs off to `AlreadyRunning` rather than looping.
        let Ok(snapshot) = tokio::fs::read(&path).await else {
            // Already gone (or unreadable); let the create below settle it either way.
            return finish_steal(&path, &owner).await;
        };
        if !is_abandoned_snapshot(&snapshot, &path).await {
            return Err(ImportOutcome::AlreadyRunning);
        }
        // Re-read right before removing (optional hardening): only remove if the content is
        // still exactly what was just judged abandoned. If it changed, another launch already
        // acted on this same lock -- clobbering ITS fresh lock would be wrong; leave it alone
        // and let `try_create_lock` below report `Exists` (-> `AlreadyRunning`) instead.
        if matches!(tokio::fs::read(&path).await, Ok(current) if current == snapshot) {
            let _ = tokio::fs::remove_file(&path).await;
        }
        finish_steal(&path, &owner).await
    }
}

async fn finish_steal(path: &Path, owner: &LockOwner) -> Result<ImportLock, ImportOutcome> {
    match try_create_lock(path, owner).await {
        LockCreate::Created => Ok(ImportLock {
            path: path.to_path_buf(),
        }),
        LockCreate::Exists => Err(ImportOutcome::AlreadyRunning),
        LockCreate::Error(err) => Err(ImportOutcome::Failed(format!("creating {path:?}: {err}"))),
    }
}

/// Atomic: writes `owner` to a uniquely-named temp file, then `hard_link`s it into place (fails
/// with `AlreadyExists` if `path` already exists, never overwriting) -- a reader can never
/// observe `path` existing but empty.
async fn try_create_lock(path: &Path, owner: &LockOwner) -> LockCreate {
    use tokio::io::AsyncWriteExt;
    let tmp = path.with_file_name(format!("{LOCK_FILE}.{}.tmp", owner.pid));
    let bytes = serde_json::to_vec(owner).unwrap_or_default();
    let write_result: std::io::Result<()> = async {
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await
    }
    .await;
    if let Err(err) = write_result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return LockCreate::Error(err);
    }
    let result = tokio::fs::hard_link(&tmp, path).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    match result {
        Ok(()) => LockCreate::Created,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => LockCreate::Exists,
        Err(err) => LockCreate::Error(err),
    }
}

/// A lock is abandoned (safe to steal) when its recorded owner is confirmably not that same
/// live process anymore (`process_matches` checks pid AND creation time, so a reused pid is
/// never mistaken for the original owner), or -- for an empty/unparseable file, which the
/// atomic write above should prevent but a defensive fallback still covers -- when its mtime is
/// older than a few minutes. Takes an already-read `bytes` snapshot rather than re-reading
/// `path` itself, so the caller can re-read and compare afterward before removing (gate-round-3
/// optional hardening): acting on a stale-at-read-time snapshot instead of the current file
/// content would risk deleting a DIFFERENT, freshly-written lock a racing launch just created.
async fn is_abandoned_snapshot(bytes: &[u8], path: &Path) -> bool {
    match serde_json::from_slice::<LockOwner>(bytes) {
        Ok(owner) => !process_matches(owner.pid, owner.created_at_ticks),
        Err(_) => is_mtime_stale(path).await,
    }
}

async fn is_mtime_stale(path: &Path) -> bool {
    match tokio::fs::metadata(path).await.and_then(|m| m.modified()) {
        Ok(modified) => std::time::SystemTime::now()
            .duration_since(modified)
            .map(|age| age.as_millis() > MTIME_STALE_AFTER_MILLIS)
            .unwrap_or(false),
        Err(_) => true,
    }
}

fn filetime_to_ticks(ft: windows_filetime::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

#[cfg(target_os = "windows")]
mod windows_filetime {
    pub use windows::Win32::Foundation::FILETIME;
}

#[cfg(not(target_os = "windows"))]
mod windows_filetime {
    #[derive(Default)]
    pub struct FILETIME {
        pub dwLowDateTime: u32,
        pub dwHighDateTime: u32,
    }
}

#[cfg(target_os = "windows")]
fn current_process_created_at() -> Result<u64, String> {
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    use windows_filetime::FILETIME;
    // Safety: a single documented Win32 API call on this process's own pseudo-handle (never
    // closed, as `GetCurrentProcess` docs require); every output parameter is a local on this
    // function's own stack.
    unsafe {
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        // Gate-round-4: a failure here used to be swallowed and recorded as tick 0, which
        // would make every future launch's `process_matches` compare against a fabricated
        // value instead of a real one -- propagated as `Failed` instead (`acquire`'s own `?`),
        // since this call should never realistically fail for a process reading its own times.
        .map_err(|err| format!("GetProcessTimes (own process): {err}"))?;
        Ok(filetime_to_ticks(creation))
    }
}

#[cfg(not(target_os = "windows"))]
fn current_process_created_at() -> Result<u64, String> {
    Ok(0)
}

#[cfg(target_os = "windows")]
fn process_matches(pid: u32, expected_created_at_ticks: u64) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_filetime::FILETIME;
    const STILL_ACTIVE: u32 = 259;
    // Safety: a single documented Win32 API pair, the same style `process/job_object.rs` already
    // uses elsewhere in this crate; `handle` is closed on every path before returning.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut exit_code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == STILL_ACTIVE;
        let matches = alive && {
            let (mut creation, mut exit, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok()
                && filetime_to_ticks(creation) == expected_created_at_ticks
        };
        let _ = CloseHandle(handle);
        matches
    }
}

/// Always "not a match" off Windows (this build's own target is Windows-only, spec.md
/// Assumptions; `GetProcessTimes`/`OpenProcess` have no portable equivalent here) -- a live
/// owner's lock would always be (harmlessly) stolen on a non-Windows build of this crate.
#[cfg(not(target_os = "windows"))]
fn process_matches(_pid: u32, _expected_created_at_ticks: u64) -> bool {
    false
}

impl Drop for ImportLock {
    /// Removes the lock file ONLY if it still records THIS process's own pid (gate-round-3
    /// MEDIUM): guards against deleting a different owner's lock in the unlikely case this
    /// process's own lock was itself stolen (mistakenly or otherwise) while still running.
    fn drop(&mut self) {
        let Ok(bytes) = std::fs::read(&self.path) else {
            return;
        };
        if let Ok(owner) = serde_json::from_slice::<LockOwner>(&bytes) {
            if owner.pid == std::process::id() {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}
