// Issue #891 holder detection: detects whether anything external still holds a Session's
// worktree folder (Stuart's 2026-10-19 grill, issuecomment-6266131548, amended by
// issuecomment-6266265342). Two complementary checks, exposed as SEPARATE functions
// (`check_named_holders`/`check_folder_in_use`) rather than one combined preflight, because the
// caller (`ipc::sessions_lifecycle`'s `sessions.delete`) MUST run its own agent's shutdown
// BETWEEN them -- see `check_folder_in_use`'s own doc comment for why:
//
//   (a) Windows Restart Manager (`RmRegisterResources`/`RmGetList`) over the worktree path,
//       which names a PROGRAM (image name) and PID holding an open FILE HANDLE somewhere inside
//       it. This Session's own recorded `omp` pids (`process::pid_records::pids_for_session`)
//       are excluded from the result first -- the agent itself holding its own files open is
//       never a reason to refuse deleting it. Runs BEFORE the agent is stopped: a refusal here
//       leaves the Session exactly as it was.
//   (b) A safe rename probe, run ONLY when (a) found nobody AND only AFTER this Session's own
//       agent has been shut down: a cwd holder (a terminal or File Explorer window merely
//       sitting inside the folder) holds no file handle Restart Manager can see, only a
//       directory handle via the Windows "current directory" mechanism -- the amendment's own
//       words, "a cwd holder is invisible to Restart Manager". Renaming the folder to a sibling
//       name inside the worktrees root and straight back fails with a sharing violation if
//       anything still has it open as a working directory; the rename-BACK failing is the one
//       outcome that must never be silently swallowed -- the real files would then sit at the
//       probe name, not the original path, so that case reports the exact current path plainly
//       instead.
//
// Refract never ends a process (Stuart's grill, Skippy's 2026-10-19 decision): this module only
// NAMES holders, it never calls `TerminateProcess` or anything like it.

use std::path::{Path, PathBuf};

use super::git::{GitError, GitErrorCode};
use super::worktree_validity::is_within_worktrees_root;
use super::worktrees::worktrees_root;

mod diag;

#[derive(Debug, Clone)]
pub struct Holder {
    pub name: String,
    pub pid: u32,
}

/// Issue #891 gate round (S1): a cheap, no-git-call containment guard run before EITHER holder
/// check ever touches Restart Manager or the rename probe -- a corrupted or hand-edited
/// registry entry naming a path outside Refract's own worktrees root must never reach either
/// one. See `worktree_validity::is_within_worktrees_root`'s own doc comment.
fn outside_worktrees_root_refusal(worktree_path: &Path) -> GitError {
    GitError::new(
        GitErrorCode::WorktreeFailed,
        format!(
            "Refract did not delete anything. {} is outside Refract's worktree folder, so Refract will not check it for holders or remove it. Nothing was touched.",
            worktree_path.display()
        ),
    )
}

/// The sibling name the rename probe uses, inside the SAME parent directory as `worktree_path`
/// (so the rename is a same-volume, metadata-only operation) -- Stuart's own example wording,
/// "a sibling name inside the worktrees root (e.g. `<name>.refract-delete-probe`)".
fn probe_sibling_path(worktree_path: &Path) -> Option<PathBuf> {
    let file_name = worktree_path.file_name()?.to_string_lossy().into_owned();
    Some(worktree_path.with_file_name(format!("{file_name}.refract-delete-probe")))
}

/// Windows sharing/lock errors a rename of an in-use folder or file raises: `ERROR_SHARING_
/// VIOLATION` (32), `ERROR_ACCESS_DENIED` (5, e.g. a process with the folder as its working
/// directory), and `ERROR_LOCK_VIOLATION` (33).
fn is_in_use_error(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(32) | Some(5) | Some(33))
}

fn named_holders_message(worktree_path: &Path, holders: &[Holder]) -> String {
    let who = holders
        .iter()
        .map(|h| {
            let name = if h.name.trim().is_empty() {
                "A program"
            } else {
                h.name.trim()
            };
            format!("{name} (process {})", h.pid)
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Refract did not delete anything. {who} still has {} open. Close it, then choose Retry.",
        worktree_path.display()
    )
}

/// Stuart's own exact wording (issuecomment-6266265342): used verbatim, not paraphrased, since
/// nothing more specific is known in this case (Restart Manager found nobody; only the rename
/// probe detected use).
const FOLDER_IN_USE_MESSAGE: &str =
    "A program has this folder open, for example a terminal or File Explorer window. Close it, then Retry.";

fn rename_back_failed_message(worktree_path: &Path, probe_path: &Path) -> String {
    format!(
        "Refract did not delete anything, but could not rename {} back after checking whether it was in use. Nothing was lost: your files are currently at {}. Move that folder back to {} yourself, then choose Retry.",
        worktree_path.display(),
        probe_path.display(),
        worktree_path.display()
    )
}

/// Names a program (and pid) holding an open FILE HANDLE somewhere inside `worktree_path`, via
/// Windows Restart Manager, excluding `exclude_pids` (this Session's own recorded `omp` root
/// processes -- the agent itself holding its own files open is never a reason to refuse).
/// Returns `Ok(())` when nothing visible holds a file (Stuart: "proceed if no holder is
/// visible" -- not a guarantee, only that nothing DETECTABLE does), or a `WorktreeHeld` error
/// naming the holder otherwise. Safe to call with the Session's own agent still running (it is
/// designed to run BEFORE that agent is stopped, so a refusal here leaves the Session exactly
/// as it was): unlike `check_folder_in_use` below, a named FILE holder is never this Session's
/// own doing once its own pids are excluded. A missing folder is not this check's concern --
/// nothing to hold, so always `Ok(())`. `repo` is used only for the S1 containment guard below
/// (`worktrees_root(repo)`), never passed to Restart Manager itself.
pub async fn check_named_holders(
    repo: &Path,
    worktree_path: &Path,
    exclude_pids: &[u32],
) -> Result<(), GitError> {
    if !is_within_worktrees_root(worktree_path, &worktrees_root(repo)) {
        return Err(outside_worktrees_root_refusal(worktree_path));
    }
    if tokio::fs::symlink_metadata(worktree_path).await.is_err() {
        return Ok(());
    }

    let exclude = exclude_pids.to_vec();
    let path = worktree_path.to_path_buf();
    let named = tokio::task::spawn_blocking(move || imp::restart_manager_holders(&path, &exclude))
        .await
        .unwrap_or_default();
    if !named.is_empty() {
        return Err(GitError::new(
            GitErrorCode::WorktreeHeld,
            named_holders_message(worktree_path, &named),
        ));
    }
    Ok(())
}

/// The safe rename-and-back probe (issuecomment-6266265342's own amendment): a cwd holder (a
/// terminal or File Explorer window merely sitting inside the folder) holds no file handle
/// Restart Manager can see, only a directory handle via the Windows "current directory"
/// mechanism -- "a cwd holder is invisible to Restart Manager". Renaming the folder to a
/// sibling name inside the worktrees root and straight back fails with a sharing violation if
/// anything still has it open as a working directory.
///
/// **Must only be called once this Session's own agent has already been stopped.** Its own
/// process (`session::agent::launch`'s `OmpProcessOptions::new` sets `cwd` to exactly
/// `worktree_path`) is itself indistinguishable, via a plain rename, from a genuine external
/// cwd holder: Windows refuses the rename if ANY process at all has the folder as its working
/// directory, ours or someone else's, with no way to attribute which -- unlike
/// `check_named_holders` above, there is no pid-exclusion mechanism available here. Confirmed
/// live: called while this Session's own agent was still running, this always read as held,
/// regardless of any genuine third party, even after several retries. Calling it only after
/// shutdown trades the "a refusal leaves the Session running" wording for correctness: a
/// refusal found here may leave the agent stopped rather than literally uninterrupted, but it
/// is no longer a false positive on every ordinary Delete of a still-running Session. `repo` is
/// used only for the S1 containment guard (`worktrees_root(repo)`). `session_id`/`own_pids` are
/// used only for the pre-probe diagnostic log line below (Main's own request): never for a
/// decision, since (per this function's own doc comment above) there is no way to attribute a
/// cwd holder to a specific pid through a plain rename at all.
pub async fn check_folder_in_use(
    repo: &Path,
    worktree_path: &Path,
    session_id: &str,
    own_pids: &[u32],
) -> Result<(), GitError> {
    if !is_within_worktrees_root(worktree_path, &worktrees_root(repo)) {
        return Err(outside_worktrees_root_refusal(worktree_path));
    }
    if tokio::fs::symlink_metadata(worktree_path).await.is_err() {
        return Ok(());
    }
    diag::log_holder_diagnostics(session_id, own_pids).await;
    probe_folder_in_use(worktree_path).await
}

/// Issue #891 gate round (S5): a leftover probe folder from an earlier crashed/killed attempt
/// sitting at the exact sibling name this probe is about to rename INTO would otherwise make
/// `tokio::fs::rename` fail in a way indistinguishable from a genuine holder (or, worse, could
/// merge/clobber depending on what is already there) -- checked and refused distinctly, named
/// by its own real path, BEFORE any rename is attempted.
fn stale_probe_message(probe_path: &Path) -> String {
    format!(
        "Refract did not delete anything. A leftover probe folder from an earlier attempt still exists at {}. Remove it yourself, then choose Retry.",
        probe_path.display()
    )
}

/// Retried up to `RENAME_PROBE_ATTEMPTS` times (short, fixed backoff) before concluding "held" --
/// in BOTH directions (issue #891 gate round S6: the rename-back is no longer a single
/// best-effort attempt). Two real-world causes raise the exact same sharing/access-denied
/// errors a genuine cwd holder does, but clear within a bounded window: (1) this Session's own
/// agent, just stopped by the caller immediately before this runs -- `SessionAgent::shutdown`'s
/// own `await` only guarantees the OS process has exited, not that Windows has finished
/// releasing every handle (including its own cwd lock) by the instant that `await` returns,
/// confirmed live as a real, if narrow, race; (2) Windows Defender's real-time scan or the
/// Search indexer, still working through a `node_modules`-sized tree seconds after it finishes
/// writing. Either cause can plausibly still be active moments later for the rename BACK too,
/// not only the forward rename -- a real holder (a terminal or Explorer window actually sitting
/// in the folder) stays held across every attempt either way and is still reported exactly as
/// before. Only after every rename-back attempt fails is the catastrophic "files are currently
/// at the probe path" message shown -- that failure must still never be silently swallowed.
///
/// Live-check gate round fix: widened from 15 to 30 attempts (4.5s -> 9s) -- a real run against
/// scenario (a)'s own pnpm-shaped fixture (junctions, a 260+-char path, a few thousand files)
/// exhausted the previous 4.5s budget and still reported a false "folder in use" refusal
/// moments after the Session's own agent had genuinely finished shutting down, confirmed by
/// `app.log`'s own `sessions.delete -> err:worktree-held` landing a full ~10s after the
/// preceding `deleteCheck` (most of that gap spent in Restart Manager's own file registration
/// scan and the agent shutdown wait, leaving the rename probe too little of its own 4.5s to
/// absorb Windows not yet having released the agent's own cwd lock).
const RENAME_PROBE_ATTEMPTS: u32 = 30;
const RENAME_PROBE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

async fn probe_folder_in_use(worktree_path: &Path) -> Result<(), GitError> {
    let Some(probe_path) = probe_sibling_path(worktree_path) else {
        return Ok(());
    };
    if tokio::fs::symlink_metadata(&probe_path).await.is_ok() {
        return Err(GitError::new(
            GitErrorCode::WorktreeHeld,
            stale_probe_message(&probe_path),
        ));
    }
    let mut last_in_use_err = None;
    for attempt in 1..=RENAME_PROBE_ATTEMPTS {
        match tokio::fs::rename(worktree_path, &probe_path).await {
            Ok(()) => {
                last_in_use_err = None;
                break;
            }
            Err(err) if is_in_use_error(&err) => {
                last_in_use_err = Some(err);
                if attempt < RENAME_PROBE_ATTEMPTS {
                    tokio::time::sleep(RENAME_PROBE_RETRY_DELAY).await;
                }
            }
            Err(_) => {
                // Some unrelated I/O failure (e.g. a stale probe name from a previous crashed
                // run): not a holder signal either way -- never block Delete here on an error
                // the real removal path will surface properly on its own.
                return Ok(());
            }
        }
    }
    if last_in_use_err.is_some() {
        return Err(GitError::new(
            GitErrorCode::WorktreeHeld,
            FOLDER_IN_USE_MESSAGE.to_string(),
        ));
    }
    let mut rename_back_ok = false;
    for attempt in 1..=RENAME_PROBE_ATTEMPTS {
        if tokio::fs::rename(&probe_path, worktree_path).await.is_ok() {
            rename_back_ok = true;
            break;
        }
        if attempt < RENAME_PROBE_ATTEMPTS {
            tokio::time::sleep(RENAME_PROBE_RETRY_DELAY).await;
        }
    }
    if !rename_back_ok {
        return Err(GitError::new(
            GitErrorCode::WorktreeHeld,
            rename_back_failed_message(worktree_path, &probe_path),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod imp {
    use std::path::{Path, PathBuf};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };

    use super::Holder;

    /// Restart Manager's own `RmGetList` documents `ERROR_ACCESS_DENIED` when a path registered
    /// with `RmRegisterResources` is a DIRECTORY, not a file -- confirmed live (this crate's own
    /// test suite hit it registering the bare worktree path before this fix). Only real files
    /// may ever be registered; capped for the same reason real-world RM callers cap it (a
    /// 156k-file `node_modules` tree would otherwise make every Delete attempt walk and
    /// register the whole thing before even starting) -- Stuart's own grill already accepts an
    /// undetected holder ("proceed if no holder is visible"), so a capped, best-effort walk is
    /// the intended shape, not a shortcut around it.
    const MAX_RM_FILES: usize = 5000;

    /// Restart Manager rejects a batch containing an implausibly long path outright (observed
    /// during this issue's own triage); skipped here rather than risk poisoning the WHOLE
    /// registration call over one file RM was never going to handle well anyway -- the file
    /// itself, if truly held open, still makes the later `fs::remove_tree` removal attempt fail
    /// with a holder-shaped `wrap_fs_error`, just discovered at delete time instead of preflight.
    const MAX_RM_PATH_LEN: usize = 260;

    /// Collects up to `MAX_RM_FILES` real file paths under `root`, never descending into a link
    /// (symlink or junction -- the same rule `fs::remove_tree` enforces for removal, applied
    /// here so Restart Manager is never asked about a path outside this worktree through a
    /// redirected link).
    fn collect_files_for_rm(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if out.len() >= MAX_RM_FILES {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if out.len() >= MAX_RM_FILES {
                    break;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    stack.push(path);
                } else if path.to_string_lossy().len() <= MAX_RM_PATH_LEN {
                    out.push(path);
                }
            }
        }
        out
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn app_name_from(info: &RM_PROCESS_INFO) -> String {
        let nul = info
            .strAppName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.strAppName.len());
        String::from_utf16_lossy(&info.strAppName[..nul])
    }

    /// Every live descendant pid of any pid in `roots` -- the process PARENT TREE only
    /// (`CreateToolhelp32Snapshot`'s own `(pid, parent_pid)` table), never a process's memory
    /// (Stuart's 2026-10-19 11:35 amendment explicitly bans `ReadProcessMemory`/
    /// `NtQueryInformationProcess` for holder detection). Deliberately no identity/creation-time
    /// re-verification, unlike `process::pid_records::kill_descendant_tree`'s own much stricter
    /// walk: that one TERMINATES a process and so must defend against pid reuse before doing
    /// anything irreversible, while this is a pure read used only to WIDEN an exclude-list for
    /// Restart Manager (issue #891 gate round 1 item 4) -- a false inclusion here costs nothing
    /// worse than one more pid Restart Manager was never going to report anyway, while a missed
    /// descendant simply falls through to Restart Manager's own report, naming the Session's
    /// own dev server/node/cargo process, which this item exists to prevent.
    pub(super) fn descendant_pids(roots: &[u32]) -> Vec<u32> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        struct HandleGuard(HANDLE);
        impl Drop for HandleGuard {
            fn drop(&mut self) {
                // Safety: a single documented API call, closing exactly the handle this guard
                // owns.
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }

        // Safety: a single documented API call; the handle is closed via `HandleGuard` right
        // after the one enumeration pass below.
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return Vec::new();
        };
        let guard = HandleGuard(snapshot);
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
        drop(guard);

        let mut out = Vec::new();
        let mut frontier: Vec<u32> = roots.to_vec();
        let mut visited: std::collections::HashSet<u32> = roots.iter().copied().collect();
        while let Some(parent_pid) = frontier.pop() {
            for &(pid, ppid) in &entries {
                if ppid != parent_pid || pid == 0 || !visited.insert(pid) {
                    continue;
                }
                out.push(pid);
                frontier.push(pid);
            }
        }
        out
    }

    /// Issue #891 gate round (Main's own request, root-causing the "folder in use" refusal on a
    /// run with no planted holder): true only if `pid` currently identifies a REAL, still-
    /// running process (`OpenProcess` succeeds AND `GetExitCodeProcess` reads `STILL_ACTIVE`,
    /// not merely a closed-but-not-yet-reaped handle) -- diagnostic-only, read-only, never used
    /// to decide anything, so no pid-reuse defence is needed the way a terminate path would
    /// require.
    pub(super) fn is_pid_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        struct HandleGuard(HANDLE);
        impl Drop for HandleGuard {
            fn drop(&mut self) {
                // Safety: a single documented API call, closing exactly the handle this guard
                // owns.
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }

        if pid == 0 {
            return false;
        }
        // Safety: a single documented, read-only API call per step; the handle is closed via
        // `HandleGuard` on every return path.
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let guard = HandleGuard(handle);
            let mut exit_code: u32 = 0;
            GetExitCodeProcess(guard.0, &mut exit_code).is_ok()
                && exit_code == STILL_ACTIVE.0 as u32
        }
    }

    /// Runs one Restart Manager session over every real file `collect_files_for_rm` finds under
    /// `worktree_path`, returning every named holder (image name + pid) RM reports, minus any
    /// pid in `exclude_pids`. Best-effort: any Win32 failure along the way (or an empty
    /// worktree with no files to register at all) reports no holders found -- RM is a
    /// defence-in-depth check, never the sole gate (Stuart's grill: "proceed if no holder is
    /// visible"). Runs on a blocking-pool thread (called via `spawn_blocking`): every step here
    /// is a synchronous Win32 or filesystem call.
    pub fn restart_manager_holders(worktree_path: &Path, exclude_pids: &[u32]) -> Vec<Holder> {
        let files = collect_files_for_rm(worktree_path);
        if files.is_empty() {
            return Vec::new();
        }
        // Issue #891 gate round 1 item 4: widen the exclude set to every live descendant of
        // this Session's own recorded omp pids (dev servers, node, cargo the agent itself
        // spawned), via the process PARENT TREE -- see `descendant_pids`'s own header.
        let mut excluded: Vec<u32> = exclude_pids.to_vec();
        excluded.extend(descendant_pids(exclude_pids));

        // Safety: each Win32 call below is a single documented Restart Manager API.
        // `session_key` is a fixed-size stack buffer `RmStartSession` fills in place;
        // `wide_paths`/`filenames`/`buffer` each outlive every call that borrows them (all are
        // locals on this function's own stack/heap, never escaping it); and the session handle
        // is always ended on every return path via `SessionGuard`'s own `Drop`.
        unsafe {
            let mut session_handle: u32 = 0;
            let mut session_key = [0u16; (CCH_RM_SESSION_KEY + 1) as usize];
            let start = RmStartSession(&mut session_handle, None, PWSTR(session_key.as_mut_ptr()));
            if start != ERROR_SUCCESS {
                return Vec::new();
            }

            struct SessionGuard(u32);
            impl Drop for SessionGuard {
                fn drop(&mut self) {
                    unsafe {
                        let _ = RmEndSession(self.0);
                    }
                }
            }
            let _guard = SessionGuard(session_handle);

            let wide_paths: Vec<Vec<u16>> = files
                .iter()
                .map(|p| to_wide_null(&p.to_string_lossy()))
                .collect();
            let filenames: Vec<PCWSTR> = wide_paths.iter().map(|w| PCWSTR(w.as_ptr())).collect();
            let registered = RmRegisterResources(session_handle, Some(&filenames), None, None);
            if registered != ERROR_SUCCESS {
                return Vec::new();
            }

            let mut needed: u32 = 0;
            let mut capacity: u32 = 0;
            let mut reboot_reasons: u32 = 0;
            let first = RmGetList(
                session_handle,
                &mut needed,
                &mut capacity,
                None,
                &mut reboot_reasons,
            );
            if first != ERROR_SUCCESS && first != ERROR_MORE_DATA {
                return Vec::new();
            }
            if needed == 0 {
                return Vec::new();
            }

            let mut buffer: Vec<RM_PROCESS_INFO> =
                vec![RM_PROCESS_INFO::default(); needed as usize];
            let mut written = needed;
            let second = RmGetList(
                session_handle,
                &mut needed,
                &mut written,
                Some(buffer.as_mut_ptr()),
                &mut reboot_reasons,
            );
            if second != ERROR_SUCCESS {
                return Vec::new();
            }

            buffer
                .into_iter()
                .take(written as usize)
                .filter(|info| !excluded.contains(&info.Process.dwProcessId))
                .map(|info| Holder {
                    name: app_name_from(&info),
                    pid: info.Process.dwProcessId,
                })
                .collect()
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::path::Path;

    use super::Holder;

    pub fn restart_manager_holders(_worktree_path: &Path, _exclude_pids: &[u32]) -> Vec<Holder> {
        Vec::new()
    }

    pub(super) fn descendant_pids(_roots: &[u32]) -> Vec<u32> {
        Vec::new()
    }

    pub(super) fn is_pid_alive(_pid: u32) -> bool {
        false
    }
}
