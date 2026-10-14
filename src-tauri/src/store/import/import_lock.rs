// `ImportLock`: split out of `import.rs` to stay under the file-size cap. See that file's own
// module doc comment for the full "why a process-lifetime, PID-owned lock" reasoning; this file
// is just the mechanism.

use std::path::{Path, PathBuf};

use super::ImportOutcome;

const LOCK_FILE: &str = "electron-import.lock";

/// Closes the race the single-instance plugin doesn't cover this early, held for the REST OF
/// THIS PROCESS'S LIFETIME once won -- `lib.rs::run()` keeps the returned guard alive in a
/// local, never dropping it early. The lock file's content is the owning PID, not a timestamp:
/// `std::process::exit` (this codebase's normal shutdown path) bypasses `Drop`, so a lock
/// routinely outlives its owner; "is that PID still running" is the only trustworthy staleness
/// test, never elapsed time.
pub struct ImportLock {
    path: PathBuf,
}

impl ImportLock {
    pub async fn acquire(data_dir: &Path) -> Result<Self, ImportOutcome> {
        let path = data_dir.join(LOCK_FILE);
        let pid = std::process::id();
        loop {
            if try_create_lock(&path, pid).await {
                return Ok(Self { path });
            }
            match read_owner_pid(&path).await {
                Some(owner) if process_is_alive(owner) => {
                    return Err(ImportOutcome::AlreadyRunning)
                }
                _ => {
                    // No parseable owner, or that PID is no longer running: an abandoned lock
                    // (crash, or the normal `std::process::exit` shutdown path, which bypasses
                    // `Drop`). Steal it and try again.
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
        }
    }
}

async fn try_create_lock(path: &Path, pid: u32) -> bool {
    use tokio::io::AsyncWriteExt;
    let Ok(mut file) = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
    else {
        return false;
    };
    let _ = file
        .write_all(format!("{{\"pid\":{pid}}}").as_bytes())
        .await;
    let _ = file.sync_all().await;
    true
}

async fn read_owner_pid(path: &Path) -> Option<u32> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("pid")?.as_u64().map(|p| p as u32)
}

#[cfg(target_os = "windows")]
fn process_is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // Safety: a single documented Win32 API pair, the same style `process/job_object.rs` already
    // uses elsewhere in this crate; `handle` is closed on every path before returning.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut exit_code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == STILL_ACTIVE;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(target_os = "windows"))]
fn process_is_alive(_pid: u32) -> bool {
    false
}

impl Drop for ImportLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
