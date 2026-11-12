// PID records for orphan reaping (#656): fallback when the Job Object did not kill omp children.
// Reaping uses one handle per pid for identity check and kill, closing the pid-reuse TOCTOU.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::store::atomic_json::{read_json_file, write_json_file};

/// One record per running `omp` root process; the fallback for stale process reaping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    pid: u32,
    start_time: u64,
    session_id: String,
    // Old records lack this; an empty path never matches, so they fail closed (never reaped).
    #[serde(default)]
    image_path: String,
}

fn make_default() -> Vec<ProcessRecord> {
    Vec::new()
}

static FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Serialises every read-modify-write of `processes.json`, keeping spawn/exit writes ordered.
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

/// `(creation-time ticks, full image path)` for a running pid, or `None` if not running.
type QueryFn = fn(u32) -> Option<(u64, String)>;
/// Terminates the pid only if creation time and image path still match, on the same handle.
type TerminateFn = fn(u32, u64, &str) -> bool;

/// Call once at startup, before any Session attaches: reaps records still matching their `omp`.
pub async fn init_and_reap(data_dir: &Path) -> usize {
    let file = data_dir.join("processes.json");
    let _ = FILE_PATH.set(file.clone());
    reap_stale_with(&file, terminate_if_matching).await
}

/// Records `pid` for `session_id`, replacing any earlier record for the same pid.
pub(crate) async fn record_process(pid: u32, session_id: &str) {
    let Some(file) = require_file_path() else {
        return;
    };
    record_process_with(&file, pid, session_id, query_process).await;
}

/// Removes any record for `pid` once its process has exited.
pub(crate) async fn remove_process_record(pid: u32) {
    let Some(file) = require_file_path() else {
        return;
    };
    remove_process_record_with(&file, pid).await;
}

/// Removes every record for `session_id` regardless of pid, closing stale-record gaps (exit
/// before `state.process` was set, cancelled start, stop-then-clear race in `launch()`).
pub(crate) async fn remove_process_records_for_session(session_id: &str) {
    let Some(file) = require_file_path() else {
        return;
    };
    remove_process_records_for_session_with(&file, session_id).await;
}

/// Every pid recorded for `session_id`; read-only. The #891 holder preflight excludes these.
pub(crate) async fn pids_for_session(session_id: &str) -> Vec<u32> {
    let Some(file) = require_file_path() else {
        return Vec::new();
    };
    pids_for_session_with(&file, session_id).await
}

async fn pids_for_session_with(file: &Path, session_id: &str) -> Vec<u32> {
    let _guard = QUEUE.lock().await;
    let records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    records
        .into_iter()
        .filter(|r| r.session_id == session_id)
        .map(|r| r.pid)
        .collect()
}

async fn record_process_with(file: &Path, pid: u32, session_id: &str, query: QueryFn) {
    let (start_time, image_path) = query(pid).unwrap_or_else(|| (0, default_image_path()));
    let _guard = QUEUE.lock().await;
    let mut records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    records.retain(|r| r.pid != pid);
    records.push(ProcessRecord {
        pid,
        start_time,
        session_id: session_id.to_string(),
        image_path,
    });
    if let Err(err) = write_json_file(file, &records).await {
        log::error!("pid_records: failed to record process: {err}");
    }
}

/// Fallback image path when the pid query fails: the path Refract resolved `omp` to.
fn default_image_path() -> String {
    crate::process::executables::resolve_omp()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
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
            log::error!("pid_records: failed to remove process record: {err}");
        }
    }
}

async fn remove_process_records_for_session_with(file: &Path, session_id: &str) {
    let _guard = QUEUE.lock().await;
    let mut records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    let before = records.len();
    records.retain(|r| r.session_id != session_id);
    if records.len() != before {
        if let Err(err) = write_json_file(file, &records).await {
            log::error!("pid_records: failed to remove session records: {err}");
        }
    }
}

async fn reap_stale_with(file: &Path, terminate: TerminateFn) -> usize {
    let _guard = QUEUE.lock().await;
    let records: Vec<ProcessRecord> = read_json_file(file, make_default)
        .await
        .unwrap_or_else(|_| make_default());
    let mut stopped = 0usize;
    for record in &records {
        if terminate(record.pid, record.start_time, &record.image_path) {
            stopped += 1;
        }
    }
    // Every record is stopped or stale after this pass, so the file is reset.
    if let Err(err) = write_json_file(file, &make_default()).await {
        log::error!("pid_records: failed to clear processes.json after reap: {err}");
    }
    stopped
}

/// True only when `current` matches the recorded creation time and image path, and that path is
/// still the resolved `omp` (`None` never matches). A reused pid is never the same life.
fn identity_matches(
    current: Option<(u64, String)>,
    recorded_start_time: u64,
    recorded_image_path: &str,
    resolved_omp: Option<&str>,
) -> bool {
    let Some((start_time, image_path)) = current else {
        return false;
    };
    if start_time != recorded_start_time {
        return false;
    }
    if !image_path.eq_ignore_ascii_case(recorded_image_path) {
        return false;
    }
    resolved_omp.is_some_and(|resolved| image_path.eq_ignore_ascii_case(resolved))
}

#[cfg(target_os = "windows")]
fn terminate_if_matching(pid: u32, recorded_start_time: u64, recorded_image_path: &str) -> bool {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            // Safety: `self.0` is a handle opened by `OpenProcess` below and closed only here.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    if pid == 0 {
        return false;
    }
    let resolved_omp = crate::process::executables::resolve_omp()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    // Safety: single documented Win32 calls on locals that outlive them. One handle serves the
    // identity check and `TerminateProcess` (no pid-reuse window); closed once via `HandleGuard`.
    unsafe {
        // Shared reference moment for the root and every descendant: anything created after it
        // cannot be a process this pass observed (snapshot-to-`OpenProcess` pid-reuse TOCTOU).
        let snapshot_ticks = {
            let ft = GetSystemTimePreciseAsFileTime();
            ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
        };
        let Ok(handle) = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        ) else {
            return false;
        };
        let guard = HandleGuard(handle);

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(guard.0, &mut creation, &mut exit, &mut kernel, &mut user).is_err() {
            return false;
        }
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        if ticks > snapshot_ticks {
            // Fail closed: newer than the reference moment means a reused pid.
            return false;
        }

        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        if QueryFullProcessImageNameW(
            guard.0,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_err()
        {
            return false;
        }
        let image_path = String::from_utf16_lossy(&buf[..len as usize]);

        if !identity_matches(
            Some((ticks, image_path)),
            recorded_start_time,
            recorded_image_path,
            resolved_omp.as_deref(),
        ) {
            return false;
        }

        // Backstop for when the Job Object (`job_object.rs`) did not cover the descendants.
        let root_killed = TerminateProcess(guard.0, 1).is_ok();
        if root_killed {
            kill_descendant_tree(pid, ticks, snapshot_ticks);
        }
        root_killed
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_if_matching(_pid: u32, _recorded_start_time: u64, _recorded_image_path: &str) -> bool {
    false
}

/// Terminates every live descendant of a just-killed `omp` root. Names from the snapshot are
/// never trusted; each candidate is re-verified on its own handle (created after its parent
/// and not after `snapshot_ticks`, image query succeeds) before `TerminateProcess`.
#[cfg(target_os = "windows")]
fn kill_descendant_tree(root_pid: u32, root_creation_ticks: u64, snapshot_ticks: u64) -> usize {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            // Safety: same guard as in `terminate_if_matching`.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // Safety: one documented API call; the handle is closed via `HandleGuard`.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return 0;
    };
    let snapshot_guard = HandleGuard(snapshot);
    let mut entries: Vec<(u32, u32)> = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // Safety: `entry` is `dwSize`-stamped as the API requires and outlives both calls.
    unsafe {
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
    }
    drop(snapshot_guard);

    walk_descendants(
        &entries,
        root_pid,
        root_creation_ticks,
        |pid, parent_creation_ticks| {
            // Safety: one handle for the identity re-check and the terminate, closed once.
            let Ok(handle) = (unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    pid,
                )
            }) else {
                return None;
            };
            let guard = HandleGuard(handle);
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            // Safety: same call as in `terminate_if_matching`.
            if unsafe { GetProcessTimes(guard.0, &mut creation, &mut exit, &mut kernel, &mut user) }
                .is_err()
            {
                return None;
            }
            let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            if ticks < parent_creation_ticks {
                // Pid-reuse defence: a genuine child is created at or after its parent.
                return None;
            }
            if ticks > snapshot_ticks {
                // Fail closed: newer than the reference moment means a reused pid.
                return None;
            }
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            // Safety: same call as in `terminate_if_matching`.
            if unsafe {
                QueryFullProcessImageNameW(
                    guard.0,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
            }
            .is_err()
            {
                return None;
            }
            // Safety: `TerminateProcess` on the SAME handle just verified above.
            let terminated = unsafe { TerminateProcess(guard.0, 1) }.is_ok();
            Some((ticks, terminated))
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn kill_descendant_tree(_root_pid: u32, _root_creation_ticks: u64, _snapshot_ticks: u64) -> usize {
    0
}

/// BFS from the root over `(pid, parent_pid)`; `verify` returns `Some((ticks, terminated))` for a
/// kept descendant or `None` to skip its subtree. Returns the number terminated.
fn walk_descendants(
    entries: &[(u32, u32)],
    root_pid: u32,
    root_creation_ticks: u64,
    mut verify: impl FnMut(u32, u64) -> Option<(u64, bool)>,
) -> usize {
    let mut killed = 0usize;
    let mut frontier: Vec<(u32, u64)> = vec![(root_pid, root_creation_ticks)];
    let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::from([root_pid]);
    while let Some((parent_pid, parent_creation_ticks)) = frontier.pop() {
        for &(pid, ppid) in entries {
            if ppid != parent_pid || pid == 0 || !visited.insert(pid) {
                continue;
            }
            if let Some((ticks, terminated)) = verify(pid, parent_creation_ticks) {
                if terminated {
                    killed += 1;
                }
                frontier.push((pid, ticks));
            }
        }
    }
    killed
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
            // Safety: same guard as in `terminate_if_matching`.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    if pid == 0 {
        return None;
    }
    // Safety: read-only; no `PROCESS_TERMINATE` requested and nothing is terminated here.
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
        let image_path = String::from_utf16_lossy(&buf[..len as usize]);
        Some((ticks, image_path))
    }
}

#[cfg(not(target_os = "windows"))]
fn query_process(_pid: u32) -> Option<(u64, String)> {
    None
}

#[cfg(test)]
#[path = "pid_records.test.rs"]
mod tests;
