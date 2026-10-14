// PID record bookkeeping for orphan reaping (#515, #656 races), part of agent termination (lane
// R3, issue #786). Pre-declared so lane R3 is the only lane that ever edits this file (issue
// #784, "Pre-declare per-lane Rust files").
//
// Port of `src/main/process/pidRecords.ts`: tracks pids of running `omp` root processes across
// an app restart, so a fresh Refract process can detect and force-kill processes orphaned by a
// previous crash before it starts spawning new ones. The Job Object (`job_object.rs`) is the
// primary line of defence (it kills every descendant the instant Refract's own process dies);
// this file is the fallback for the case where Refract itself was force-killed too abruptly for
// even that to run its course, or where the record simply predates a machine restart.
//
// Deliberate deviation from the TS port ("port the fixed behaviour, not the bug", lane brief):
// the Electron build shells out to PowerShell's `Get-Process` for every liveness/identity check.
// This build already depends on `windows-rs` for real Win32 bindings (`job_object.rs`), so pid
// identity (creation time + image name) is queried directly via `OpenProcess`/`GetProcessTimes`/
// `QueryFullProcessImageNameW` instead -- no process spawn per check, and no reliance on
// PowerShell being resolvable on PATH. `start_time` is kept as the raw Win32 `FILETIME` tick
// count (not an ISO string): `processes.json` is a private backend file, never read by the
// renderer or compared against anything outside this module, so the simpler, lossless
// representation is strictly better here.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use super::executables::taskkill_path;
use crate::store::atomic_json::{read_json_file, write_json_file};

/// One record per running `omp` root process; the pid-and-creation-time fallback for stale
/// process reaping. Mirrors `src/shared/model.ts`'s own `ProcessRecord` shape (pid/sessionId),
/// but see this file's header for why `startTime` is a raw tick count here instead of an ISO
/// string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    pid: u32,
    start_time: u64,
    session_id: String,
}

fn make_default() -> Vec<ProcessRecord> {
    Vec::new()
}

static FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Every read-modify-write cycle (record/remove/reap) is serialised on this lock so two
/// concurrent calls never race on the same `processes.json` file -- the Rust equivalent of the
/// TS port's own promise-chained `queue`.
static QUEUE: AsyncMutex<()> = AsyncMutex::const_new(());

fn require_file_path() -> Option<PathBuf> {
    match FILE_PATH.get() {
        Some(path) => Some(path.clone()),
        None => {
            log::error!("pid_records: used before init_and_reap; no file path set");
            None
        }
    }
}

/// `(creation-time ticks, lowercase image file name)` for a currently-running pid, or `None` if
/// the pid is not running (already exited, or reused by a different process -- either way there
/// is nothing left to identify).
type QueryFn = fn(u32) -> Option<(u64, String)>;

/// Call once, at startup, before any Session ever attaches (`lib.rs`'s own `run()`): resolves
/// `processes.json`'s path under `data_dir` and reaps every record whose pid is still the exact
/// same `omp.exe` process it was recorded against (FR-005's fallback for the rarer case the Job
/// Object's own kill-on-close did not run). Returns the number of processes force-killed.
pub async fn init_and_reap(data_dir: &Path) -> usize {
    let file = data_dir.join("processes.json");
    let _ = FILE_PATH.set(file.clone());
    reap_stale_with(&file, query_process).await
}

/// Records `pid` (a just-spawned `omp` root process for `session_id`), replacing any earlier
/// record for the same pid. Fire-and-forget (spawned, never awaited by the caller) -- mirrors
/// the TS port's own `recordProcess(...).catch(err => console.error(...))` call from
/// `OmpProcess.ts`'s spawn path: never worth making a Session's own start wait on this.
pub(crate) fn record_process(pid: u32, session_id: &str) {
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let Some(file) = require_file_path() else {
            return;
        };
        record_process_with(&file, pid, &session_id, query_process).await;
    });
}

/// Removes any record for `pid` (the Session's own process has now exited cleanly). Same
/// fire-and-forget contract as `record_process` above.
pub(crate) fn remove_process_record(pid: u32) {
    tokio::spawn(async move {
        let Some(file) = require_file_path() else {
            return;
        };
        remove_process_record_with(&file, pid).await;
    });
}

async fn record_process_with(file: &Path, pid: u32, session_id: &str, query: QueryFn) {
    let start_time = query(pid).map(|(ticks, _)| ticks).unwrap_or(0);
    let _guard = QUEUE.lock().await;
    let mut records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    records.retain(|r| r.pid != pid);
    records.push(ProcessRecord {
        pid,
        start_time,
        session_id: session_id.to_string(),
    });
    if let Err(err) = write_json_file(file, &records).await {
        log::error!("pid_records: failed to record pid {pid}: {err}");
    }
}

async fn remove_process_record_with(file: &Path, pid: u32) {
    let _guard = QUEUE.lock().await;
    let mut records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    let before = records.len();
    records.retain(|r| r.pid != pid);
    if records.len() != before {
        if let Err(err) = write_json_file(file, &records).await {
            log::error!("pid_records: failed to remove pid {pid}: {err}");
        }
    }
}

async fn reap_stale_with(file: &Path, query: QueryFn) -> usize {
    let _guard = QUEUE.lock().await;
    let records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    let mut stopped = 0usize;
    for record in &records {
        if is_same_omp_process(query(record.pid), record.start_time) && kill_pid(record.pid).await {
            stopped += 1;
        }
    }
    // Every record has now either been stopped or found stale/mismatched; none are worth
    // keeping across this reap (matches the TS port's own unconditional reset to `[]`).
    if let Err(err) = write_json_file(file, &make_default()).await {
        log::error!("pid_records: failed to clear processes.json after reap: {err}");
    }
    stopped
}

/// True only when `current` (a fresh query for the same pid) reports the exact same creation
/// time this record was made against, AND that process is still `omp.exe` -- a pid reused by an
/// unrelated process (different creation time, or the same creation time but a different image,
/// which cannot genuinely happen but is treated as a mismatch defensively either way) is never
/// treated as the same life. Pulled out as its own pure function so the classification rule is
/// unit-testable without a real `taskkill` spawn.
fn is_same_omp_process(current: Option<(u64, String)>, recorded_start_time: u64) -> bool {
    matches!(
        current,
        Some((start_time, image_name))
            if start_time == recorded_start_time && image_name == "omp.exe"
    )
}

#[cfg(target_os = "windows")]
async fn kill_pid(pid: u32) -> bool {
    use std::process::Stdio;
    use tokio::process::Command;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    Command::new(taskkill_path())
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "windows"))]
async fn kill_pid(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn query_process(pid: u32) -> Option<(u64, String)> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            // Safety: `self.0` is a valid handle this module opened itself via `OpenProcess`
            // above and never duplicates or closes anywhere else.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    if pid == 0 {
        return None;
    }
    // Safety: every Win32 call below is a single documented API; buffers passed by mutable
    // reference outlive the call that borrows them (locals on this function's own stack), and
    // the handle is closed exactly once via `HandleGuard` on every return path.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let guard = HandleGuard(handle);

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(guard.0, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;

        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(
            guard.0,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
        let full_path = String::from_utf16_lossy(&buf[..len as usize]);
        let image_name = Path::new(&full_path)
            .file_name()?
            .to_string_lossy()
            .to_lowercase();
        Some((ticks, image_name))
    }
}

#[cfg(not(target_os = "windows"))]
fn query_process(_pid: u32) -> Option<(u64, String)> {
    None
}

#[cfg(test)]
#[path = "pid_records.test.rs"]
mod tests;
