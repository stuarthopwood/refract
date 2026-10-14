// PID record bookkeeping for orphan reaping (#656 races), part of agent termination (lane R3,
// issue #786). Pre-declared so lane R3 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// Port of `src/main/process/pidRecords.ts`: tracks pids of running `omp` root processes across
// an app restart, so a fresh Refract process can detect and force-kill processes orphaned by a
// previous crash before it starts spawning new ones. The Job Object (`job_object.rs`) is the
// primary line of defence (it kills every descendant the instant Refract's own process dies);
// this file is the fallback for the case where Refract itself was force-killed too abruptly for
// even that to run its course, or where the record simply predates a machine restart.
//
// Deliberate deviation from the TS port ("port the fixed behaviour, not the bug", lane brief):
// the Electron build shells out to PowerShell's `Get-Process` for every liveness/identity check,
// then (on a match) a SEPARATE `taskkill /PID <n>` by pid number -- a TOCTOU window between the
// identity check and the kill where the pid could already have been reused by an unrelated
// process. This build already depends on `windows-rs` for real Win32 bindings (`job_object.rs`),
// so reaping instead opens ONE handle per candidate pid (`PROCESS_TERMINATE |
// PROCESS_QUERY_LIMITED_INFORMATION`), re-checks creation time AND full image path (not just the
// bare file name) against both the recorded values and the live-resolved `omp` path, and calls
// `TerminateProcess` on that SAME handle -- closing the window entirely (security gate-fix).
// `start_time` is kept as the raw Win32 `FILETIME` tick count (not an ISO string): `processes.
// json` is a private backend file, never read by the renderer or compared against anything
// outside this module, so the simpler, lossless representation is strictly better here.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::store::atomic_json::{read_json_file, write_json_file};

/// One record per running `omp` root process; the pid-and-creation-time fallback for stale
/// process reaping. Mirrors `src/shared/model.ts`'s own `ProcessRecord` shape (pid/sessionId)
/// plus `image_path` (this port's own addition, security gate-fix: reaping needs the FULL image
/// path, not just a bare file name, to tell a genuine `omp` process apart from an unrelated one
/// that merely happens to share its file name).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    pid: u32,
    start_time: u64,
    session_id: String,
    // Gate-fix (security review LOW): `#[serde(default)]` so a record written by an EARLIER
    // version of this file (before `image_path` existed) deserialises as an empty string
    // instead of quarantining the whole `processes.json` file -- an empty path never matches
    // `identity_matches`' own comparisons (fails closed: that record is just never reaped,
    // never wrongly matched against something else).
    #[serde(default)]
    image_path: String,
}

fn make_default() -> Vec<ProcessRecord> {
    Vec::new()
}

static FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Every read-modify-write cycle (record/remove/reap) is serialised on this lock so two
/// concurrent calls never race on the same `processes.json` file -- the Rust equivalent of the
/// TS port's own promise-chained `queue`. Gate-fix (perf/correctness): `record_process`/
/// `remove_process_record` are now plain `async fn`s their callers `.await` directly (no
/// internal `tokio::spawn`), so a `launch()` that records a pid and a `handle_exit` that later
/// removes the SAME pid are strictly ordered by their own callers' own control flow -- two
/// independently-spawned fire-and-forget tasks had no such guarantee, and a very-short-lived
/// process could otherwise have its "exited" write land before its own "spawned" write ever did.
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

/// `(creation-time ticks, full image path)` for a currently-running pid, or `None` if the pid is
/// not running (already exited, or reused by a different process -- either way there is nothing
/// left to identify).
type QueryFn = fn(u32) -> Option<(u64, String)>;
/// Re-checks a recorded pid's identity (creation time + full image path, both against the
/// recorded values AND the live-resolved `omp` path) and, only on a genuine match, terminates it
/// on the SAME handle the identity check itself used. Returns whether it was terminated.
type TerminateFn = fn(u32, u64, &str) -> bool;

/// Call once, at startup, before any Session ever attaches (`lib.rs`'s own `run()`): resolves
/// `processes.json`'s path under `data_dir` and reaps every record whose pid is still the exact
/// same `omp` process it was recorded against (FR-005's fallback for the rarer case the Job
/// Object's own kill-on-close did not run). Returns the number of processes force-killed.
pub async fn init_and_reap(data_dir: &Path) -> usize {
    let file = data_dir.join("processes.json");
    let _ = FILE_PATH.set(file.clone());
    reap_stale_with(&file, terminate_if_matching).await
}

/// Records `pid` (a just-spawned `omp` root process for `session_id`), replacing any earlier
/// record for the same pid. Awaited by the caller (`agent/launch.rs`'s own `launch()`, right
/// after `OmpProcess::connect` succeeds) -- see `QUEUE`'s own doc comment for why this is no
/// longer fire-and-forget.
pub(crate) async fn record_process(pid: u32, session_id: &str) {
    let Some(file) = require_file_path() else {
        return;
    };
    record_process_with(&file, pid, session_id, query_process).await;
}

/// Removes any record for `pid` (the Session's own process has now exited, cleanly or not).
/// Awaited by the caller (`agent/frame.rs`'s own `handle_exit`). Same ordering contract as
/// `record_process` above.
pub(crate) async fn remove_process_record(pid: u32) {
    let Some(file) = require_file_path() else {
        return;
    };
    remove_process_record_with(&file, pid).await;
}

/// Removes every record for `session_id` regardless of pid (gate-fix, security MEDIUM round 6:
/// `sessions.delete`/`.archive` call this right after their own `shutdown()`). Three cases left
/// a stale record behind before this existed: an exit arriving during `wait_ready` (before
/// `state.process` was ever set, so `handle_exit`'s own pid-keyed `remove_process_record` never
/// ran for it), a cancelled start, or the stop-then-clear race in `launch()`'s own
/// `fail_if_process_changed`. None of these are a security issue by themselves (the reaper's own
/// identity check -- creation time AND full image path, both re-verified live -- fails closed
/// against a stale record, and `init_and_reap` empties the file at every startup regardless),
/// but a session-keyed cleanup closes the gap outright rather than leaving it to the reaper's
/// own defence-in-depth alone.
pub(crate) async fn remove_process_records_for_session(session_id: &str) {
    let Some(file) = require_file_path() else {
        return;
    };
    remove_process_records_for_session_with(&file, session_id).await;
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
        log::error!("pid_records: failed to record pid {pid}: {err}");
    }
}

/// Best-effort fallback image path when a just-spawned pid's own query fails (vanishingly rare:
/// the process was just observed alive by `OmpProcess::connect` itself) -- the path Refract
/// itself resolved `omp` to, so a later reap's own `resolve_omp()` comparison still has something
/// real to compare against instead of an empty string that could never match anything.
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
            log::error!("pid_records: failed to remove pid {pid}: {err}");
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
            log::error!("pid_records: failed to remove records for session {session_id}: {err}");
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
    // Every record has now either been stopped or found stale/mismatched; none are worth
    // keeping across this reap (matches the TS port's own unconditional reset to `[]`).
    if let Err(err) = write_json_file(file, &make_default()).await {
        log::error!("pid_records: failed to clear processes.json after reap: {err}");
    }
    stopped
}

/// True only when `current` (a fresh query for the same pid) reports the exact same creation
/// time this record was made against, the exact same full image path it was recorded with, AND
/// that path is still the one Refract itself would resolve `omp` to right now (`resolved_omp`,
/// `None` if `omp` cannot currently be resolved at all -- never trusted as a match in that case).
/// A pid reused by an unrelated process (different creation time, or a different image path
/// entirely) is never treated as the same life. Pulled out as its own pure function so the
/// classification rule is unit-testable without a real process/handle.
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
            // Safety: `self.0` is a valid handle this function opened itself via `OpenProcess`
            // below and never duplicates or closes anywhere else.
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

    // Safety: every Win32 call below is a single documented API; buffers passed by mutable
    // reference outlive the call that borrows them (locals on this function's own stack). The
    // SAME handle opened here is both the identity check (`GetProcessTimes`/
    // `QueryFullProcessImageNameW`) and, on a genuine match, the one `TerminateProcess` acts on
    // (security gate-fix: no separate re-open or pid-by-number kill, so no window for the pid to
    // have been reused by an unrelated process between check and kill); closed exactly once via
    // `HandleGuard` on every return path.
    unsafe {
        // Security gate-fix (round 4, security review MEDIUM): captured right before this whole
        // verification starts, so it is the single shared reference moment for BOTH this root
        // check and every descendant `kill_descendant_tree` walks below -- nothing created
        // AFTER this instant can be the process this reap pass actually observed, closing the
        // snapshot-to-`OpenProcess` TOCTOU (an unrelated process could otherwise reuse a pid in
        // the gap between reading `processes.json`/the Toolhelp32 snapshot and opening it here,
        // coincidentally landing inside the existing creation-time/image-path checks).
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
            // Fail closed: a process that looks newer than this call's own reference moment
            // cannot be the one `processes.json` recorded -- treat as a reused pid rather than
            // risk terminating an unrelated, brand-new process.
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

        // Security gate-fix (MEDIUM, round 6): the Job Object (`job_object.rs`,
        // `KILL_ON_JOB_CLOSE`) is the primary defence against an orphaned `omp` root's own
        // broker/tool children surviving it, but only while `join_kill_on_close` succeeded for
        // this exact process tree -- this reaper is the fallback for when it did not. Walking
        // and killing descendants here closes that same gap `OmpProcess::stop`'s own live
        // `taskkill /T` already covers for a NORMAL stop.
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

/// Walks and terminates every live descendant of a just-verified `omp` root (`pid`,
/// `root_creation_ticks`), called only after that root itself has genuinely matched and been
/// terminated. Port of this fix's own requirement (security gate-fix MEDIUM, round 6): the
/// reaper used to terminate the verified root only, leaving its broker/tool children to survive
/// whenever the Job Object itself did not cover them. One `CreateToolhelp32Snapshot` call reads
/// the whole system process table as `(pid, parent_pid)` pairs ONLY -- `szExeFile` (the
/// snapshot's own cached name) is never trusted for identity, matching this module's own "never
/// match by name" rule. Every candidate descendant is re-opened on its OWN freshly opened
/// handle and re-verified LIVE before being touched -- but unlike the root (which has one known
/// expected image path to compare against), a descendant is an arbitrary broker/tool child with
/// no single expected image, so its own re-verification is liveness-only: creation time at or
/// after its parent's own (the same pid-reuse defence the root uses) AND at or before
/// `snapshot_ticks` (security gate-fix round 4, MEDIUM: the single reference moment captured by
/// `terminate_if_matching` right before this whole reap pass began -- a candidate that looks
/// NEWER than that instant cannot be a process this pass actually observed, closing the
/// snapshot-to-`OpenProcess` TOCTOU at every level, not just the root's own), and a successful
/// `QueryFullProcessImageNameW` call on the SAME handle about to be terminated (the queried path
/// itself is intentionally not compared to anything -- its only role here is proving the handle
/// still resolves to a real, running process immediately before `TerminateProcess`, not identity
/// matching).
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
            // Safety: see `terminate_if_matching`'s own identical guard.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // Safety: a single documented API call; the returned handle is closed via `HandleGuard`
    // right after the one pass over it below.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return 0;
    };
    let snapshot_guard = HandleGuard(snapshot);
    let mut entries: Vec<(u32, u32)> = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // Safety: `entry` is sized and `dwSize`-stamped exactly as the API requires, a local on
    // this function's own stack that outlives both calls.
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
            // Safety: see `terminate_if_matching`'s own identical comment -- one handle, used for
            // both the identity re-check and the terminate, closed exactly once.
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
            // Safety: see `terminate_if_matching`'s own identical call.
            if unsafe { GetProcessTimes(guard.0, &mut creation, &mut exit, &mut kernel, &mut user) }
                .is_err()
            {
                return None;
            }
            let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            if ticks < parent_creation_ticks {
                // Pid-reuse defence: a genuine child is created at or after its own parent -- an
                // unrelated, OLDER process now holding this pid is never touched.
                return None;
            }
            if ticks > snapshot_ticks {
                // Security gate-fix (round 4, MEDIUM): a candidate that looks NEWER than the
                // shared reference moment this whole reap pass started at cannot be a process
                // that was actually alive when the Toolhelp32 snapshot was taken -- fail closed
                // rather than risk terminating a brand-new, unrelated process that happened to
                // reuse this pid.
                return None;
            }
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            // Safety: see `terminate_if_matching`'s own identical call.
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
fn kill_descendant_tree(_root_pid: u32, _root_creation_ticks: u64) -> usize {
    0
}

/// Pure BFS over `entries` (every `(pid, parent_pid)` pair in the system -- the shape
/// `CreateToolhelp32Snapshot` enumerates), walking forward from `root_pid`/`root_creation_ticks`.
/// For each CANDIDATE child found by parent-pid match, `verify(pid, parent_creation_ticks)` runs
/// the real live identity/pid-reuse re-check and returns `Some((child_creation_ticks,
/// was_terminated))` on a genuine, kept descendant (walked for ITS OWN children too, using its
/// own creation time as the new parent reference), or `None` to skip that pid and its entire
/// subtree. `killed` counts only `was_terminated == true` outcomes. Pulled out as its own pure
/// function (same reason `identity_matches` was): the BFS/visited/cycle-guard shape is
/// unit-testable against a synthetic process table, without a real process tree or Win32
/// handles.
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
            // Safety: see `terminate_if_matching`'s own identical guard.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    if pid == 0 {
        return None;
    }
    // Safety: see `terminate_if_matching`'s own identical comment (read-only here: no
    // `PROCESS_TERMINATE` requested, and nothing is ever terminated from this function).
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
