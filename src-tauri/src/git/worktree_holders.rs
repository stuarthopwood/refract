// Issue #891 preflight: detects whether anything external still holds a Session's worktree
// folder, run BEFORE the agent is stopped and before any file is touched (Stuart's 2026-10-19
// grill, issuecomment-6266131548, amended by issuecomment-6266265342). Two complementary
// checks, run in this order:
//
//   (a) Windows Restart Manager (`RmRegisterResources`/`RmGetList`) over the worktree path,
//       which names a PROGRAM (image name) and PID holding an open FILE HANDLE somewhere inside
//       it. This Session's own recorded `omp` pids (`process::pid_records::pids_for_session`)
//       are excluded from the result first -- the agent itself holding its own files open is
//       never a reason to refuse deleting it.
//   (b) A safe rename probe, run ONLY when (a) found nobody: a cwd holder (a terminal or File
//       Explorer window merely sitting inside the folder) holds no file handle Restart Manager
//       can see, only a directory handle via the Windows "current directory" mechanism -- the
//       amendment's own words, "a cwd holder is invisible to Restart Manager". Renaming the
//       folder to a sibling name inside the worktrees root and straight back fails with a
//       sharing violation if anything still has it open as a working directory; the rename-BACK
//       failing is the one outcome that must never be silently swallowed -- the real files
//       would then sit at the probe name, not the original path, so that case reports the exact
//       current path plainly instead.
//
// Refract never ends a process (Stuart's grill, Skippy's 2026-10-19 decision): this module only
// NAMES holders, it never calls `TerminateProcess` or anything like it.

use std::path::{Path, PathBuf};

use super::git::{GitError, GitErrorCode};

#[derive(Debug, Clone)]
pub struct Holder {
    pub name: String,
    pub pid: u32,
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
        "Refract did not delete anything. {who} still has {} open. Close it, then choose Delete again.",
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
        "Refract did not delete anything, but could not rename {} back after checking whether it was in use. Nothing was lost: your files are currently at {}. Move that folder back to {} yourself, then choose Delete again.",
        worktree_path.display(),
        probe_path.display(),
        worktree_path.display()
    )
}

/// Runs the full issue #891 preflight for `worktree_path`. Returns `Ok(())` when nothing visible
/// holds the folder (Stuart: "proceed if no holder is visible" -- this is not a guarantee
/// nothing holds it, only that nothing DETECTABLE does), or a `WorktreeHeld` error naming the
/// holder (or, with no named holder, the generic in-use wording) otherwise. A missing folder is
/// not this module's concern at all -- nothing to hold, so always `Ok(())`.
pub async fn preflight(worktree_path: &Path, exclude_pids: &[u32]) -> Result<(), GitError> {
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

    probe_folder_in_use(worktree_path).await
}

async fn probe_folder_in_use(worktree_path: &Path) -> Result<(), GitError> {
    let Some(probe_path) = probe_sibling_path(worktree_path) else {
        return Ok(());
    };
    if let Err(err) = tokio::fs::rename(worktree_path, &probe_path).await {
        return if is_in_use_error(&err) {
            Err(GitError::new(
                GitErrorCode::WorktreeHeld,
                FOLDER_IN_USE_MESSAGE.to_string(),
            ))
        } else {
            // Some unrelated I/O failure (e.g. a stale probe name from a previous crashed run):
            // not a holder signal either way -- never block Delete here on an error the real
            // removal path will surface properly on its own.
            Ok(())
        };
    }
    if tokio::fs::rename(&probe_path, worktree_path).await.is_err() {
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
                .filter(|info| !exclude_pids.contains(&info.Process.dwProcessId))
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
}
