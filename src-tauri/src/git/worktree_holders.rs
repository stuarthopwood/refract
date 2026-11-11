// Holder detection for Session worktrees. Two separate checks because the caller must stop its
// agent between them: Restart Manager (file handles) before, rename probe (cwd holders) after.
// Only names holders; never terminates a process.

use std::path::{Path, PathBuf};

use crate::fs::remove_tree::{checked_canonical_path, ContainmentCheck};

use super::git::{shown_path, GitError, GitErrorCode};
use super::worktrees::worktrees_root;

mod diag;

#[derive(Debug, Clone)]
pub struct Holder {
    pub name: String,
    pub pid: u32,
}

// Shown paths are lexically cleaned (`..` collapsed, separators normalised) so a user never sees one.
fn shown(path: &Path) -> String {
    shown_path(path)
}

// Cheap containment guard so a bad registry entry never reaches Restart Manager or the probe.
fn outside_worktrees_root_refusal(worktree_path: &Path) -> GitError {
    GitError::new(
        GitErrorCode::WorktreeFailed,
        format!(
            "Refract did not delete anything. {} is outside Refract's worktree folder, so Refract will not check it for holders or remove it. Nothing was touched.",
            shown(worktree_path)
        ),
    )
}

// A failed lstat/canonicalise is not evidence of a link, so it must not read as "outside".
fn unreadable_containment_refusal(worktree_path: &Path, source: &std::io::Error) -> GitError {
    GitError::new(
        GitErrorCode::WorktreeFailed,
        format!(
            "Refract did not delete anything. It could not check {} ({source}), so it cannot tell whether a program has it open. Nothing was touched. Close any terminal or editor open in that folder, then choose Retry.",
            shown(worktree_path)
        ),
    )
}

// Same parent directory keeps the rename a same-volume, metadata-only operation.
fn probe_sibling_path(worktree_path: &Path) -> Option<PathBuf> {
    let file_name = worktree_path.file_name()?.to_string_lossy().into_owned();
    Some(worktree_path.with_file_name(format!("{file_name}.refract-delete-probe")))
}

// Sharing violation (32), access denied (5, e.g. cwd holder), lock violation (33).
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
        shown(worktree_path)
    )
}

// Exact agreed wording; used when only the rename probe detected use, so nothing more specific is known.
const FOLDER_IN_USE_MESSAGE: &str =
    "Refract did not delete anything. A program has this folder open, for example a terminal or File Explorer window. Close it, then choose Retry.";

fn rename_back_failed_message(worktree_path: &Path, probe_path: &Path) -> String {
    format!(
        "Refract did not delete anything, but could not rename {} back after checking whether it was in use. Nothing was lost: your files are currently at {}. Move that folder back to {} yourself, then choose Retry.",
        shown(worktree_path),
        shown(probe_path),
        shown(worktree_path)
    )
}

/// Names a program holding an open file handle inside `worktree_path` via Restart Manager, ignoring `exclude_pids`.
// Safe before the agent stops (own pids excluded). Not a guarantee: only detectable holders count.
// `repo` is used only for the containment guard.
pub async fn check_named_holders(
    repo: &Path,
    worktree_path: &Path,
    exclude_pids: &[u32],
) -> Result<(), GitError> {
    let root = worktrees_root(repo);
    let path = worktree_path.to_path_buf();
    let check = tokio::task::spawn_blocking(move || checked_canonical_path(&path, &root))
        .await
        .unwrap_or(ContainmentCheck::OutsideBoundary);
    let canonical_path = match check {
        ContainmentCheck::Missing => return Ok(()),
        ContainmentCheck::OutsideBoundary => {
            return Err(outside_worktrees_root_refusal(worktree_path))
        }
        ContainmentCheck::Unreadable(source) => {
            return Err(unreadable_containment_refusal(worktree_path, &source))
        }
        ContainmentCheck::Ok(p) => p,
    };

    let exclude = exclude_pids.to_vec();
    let named = tokio::task::spawn_blocking(move || {
        imp::restart_manager_holders(&canonical_path, &exclude)
    })
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

/// Rename-and-back probe for cwd holders, which Restart Manager cannot see.
// Call only after this Session's own agent has stopped: its cwd is the worktree, and a plain
// rename cannot tell it from an external holder (always reads as held).
// `session_id`/`own_pids` feed only a diagnostic log, never a decision.
pub async fn check_folder_in_use(
    repo: &Path,
    worktree_path: &Path,
    session_id: &str,
    own_pids: &[u32],
) -> Result<(), GitError> {
    let root = worktrees_root(repo);
    let path = worktree_path.to_path_buf();
    let check = tokio::task::spawn_blocking(move || checked_canonical_path(&path, &root))
        .await
        .unwrap_or(ContainmentCheck::OutsideBoundary);
    let canonical_path = match check {
        ContainmentCheck::Missing => {
            // Missing may mean a crashed Delete left the folder at its probe name; check for that.
            if let Some(probe_path) = probe_sibling_path(worktree_path) {
                if tokio::fs::symlink_metadata(&probe_path).await.is_ok() {
                    return Err(GitError::new(
                        GitErrorCode::WorktreeHeld,
                        rename_back_failed_message(worktree_path, &probe_path),
                    ));
                }
            }
            return Ok(());
        }
        ContainmentCheck::OutsideBoundary => {
            return Err(outside_worktrees_root_refusal(worktree_path))
        }
        ContainmentCheck::Unreadable(source) => {
            return Err(unreadable_containment_refusal(worktree_path, &source))
        }
        ContainmentCheck::Ok(p) => p,
    };
    diag::log_holder_diagnostics(session_id, own_pids).await;
    probe_folder_in_use(&canonical_path).await
}

// A leftover probe folder would make the rename fail like a real holder (or clobber); refuse it first.
fn stale_probe_message(probe_path: &Path) -> String {
    format!(
        "Refract did not delete anything. A leftover probe folder from an earlier attempt still exists at {}. Remove it yourself, then choose Retry.",
        shown(probe_path)
    )
}

// Retried in both directions: a just-stopped agent's cwd lock, or Defender/indexer scanning a big
// tree, raise holder-shaped errors that clear within seconds. Rename-back failure must never be swallowed.
// 30 x 300ms: a smaller budget gave false "in use" refusals on a large pnpm-shaped tree.
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
                // Unrelated I/O failure is not a holder signal; the real removal surfaces it.
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

    // RmGetList fails with ACCESS_DENIED for directories, so only files are registered. Capped so a
    // huge node_modules is not walked every Delete; best-effort is accepted.
    const MAX_RM_FILES: usize = 5000;

    // RM rejects a whole batch containing an overlong path; skip it (remove_tree will surface a held file).
    const MAX_RM_PATH_LEN: usize = 260;

    /// Collects up to `MAX_RM_FILES` file paths under `root`, never descending into links.
    // Also refuses a link `root`, else `read_dir` would walk its target.
    fn collect_files_for_rm(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        match std::fs::symlink_metadata(root) {
            Ok(meta) if !meta.file_type().is_symlink() => {}
            _ => return out,
        }
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

    /// Every live descendant pid of `roots`, from the process parent tree only.
    // No process-memory reads. No pid-reuse check: this only widens an exclude list, unlike a terminate path.
    pub(super) fn descendant_pids(roots: &[u32]) -> Vec<u32> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        struct HandleGuard(HANDLE);
        impl Drop for HandleGuard {
            fn drop(&mut self) {
                // SAFETY: closes exactly the handle this guard owns.
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }

        // SAFETY: single documented API call; handle closed via `HandleGuard` after enumeration.
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return Vec::new();
        };
        let guard = HandleGuard(snapshot);
        let mut entries: Vec<(u32, u32)> = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: `entry` is a sized, `dwSize`-stamped local outliving both calls.
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

    /// True only if `pid` is a real, still-running process. Diagnostic-only, never a decision.
    pub(super) fn is_pid_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        struct HandleGuard(HANDLE);
        impl Drop for HandleGuard {
            fn drop(&mut self) {
                // SAFETY: closes exactly the handle this guard owns.
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }

        if pid == 0 {
            return false;
        }
        // SAFETY: read-only API calls; handle closed via `HandleGuard` on every return path.
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

    /// Returns named Restart Manager holders under `worktree_path`, minus `exclude_pids`.
    // Best-effort: any Win32 failure or no files reports none. Blocking; call via `spawn_blocking`.
    pub fn restart_manager_holders(worktree_path: &Path, exclude_pids: &[u32]) -> Vec<Holder> {
        let files = collect_files_for_rm(worktree_path);
        if files.is_empty() {
            return Vec::new();
        }
        // Also exclude the agent's descendants (dev servers, node, cargo) via the parent tree.
        let mut excluded: Vec<u32> = exclude_pids.to_vec();
        excluded.extend(descendant_pids(exclude_pids));

        // SAFETY: single documented RM calls; buffers are locals outliving every borrow, and
        // `SessionGuard` ends the session on every return path.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_containment_refusal_names_the_cause_and_is_not_the_outside_wording() {
        let source = std::io::Error::from_raw_os_error(5);
        let msg = unreadable_containment_refusal(Path::new("C:/w/s1"), &source).message;
        assert!(msg.contains("could not check"), "{msg}");
        assert!(msg.contains("choose Retry"), "{msg}");
        assert!(!msg.contains("outside"), "{msg}");
    }

    #[test]
    fn shown_paths_collapse_dot_dot_so_a_session_path_never_shows_one() {
        let raw =
            Path::new("C:\\r\\scratch-repo\\..\\pinion-worktrees\\scratch-repo\\brave-puffin");
        let shown = shown(raw);
        assert!(!shown.contains(".."), "{shown}");
        assert!(
            shown.ends_with("pinion-worktrees\\scratch-repo\\brave-puffin")
                || shown.ends_with("pinion-worktrees/scratch-repo/brave-puffin"),
            "{shown}"
        );
    }
}
