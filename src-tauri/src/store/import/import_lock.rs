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
        let owner = LockOwner {
            pid: std::process::id(),
            created_at_ticks: current_process_created_at(),
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
        if !is_abandoned(&path).await {
            return Err(ImportOutcome::AlreadyRunning);
        }
        let _ = tokio::fs::remove_file(&path).await;
        match try_create_lock(&path, &owner).await {
            LockCreate::Created => Ok(Self { path }),
            LockCreate::Exists => Err(ImportOutcome::AlreadyRunning),
            LockCreate::Error(err) => {
                Err(ImportOutcome::Failed(format!("creating {path:?}: {err}")))
            }
        }
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
/// older than a few minutes.
async fn is_abandoned(path: &Path) -> bool {
    let Ok(bytes) = tokio::fs::read(path).await else {
        return true;
    };
    match serde_json::from_slice::<LockOwner>(&bytes) {
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
fn current_process_created_at() -> u64 {
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
        let _ = GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        );
        filetime_to_ticks(creation)
    }
}

#[cfg(not(target_os = "windows"))]
fn current_process_created_at() -> u64 {
    0
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
