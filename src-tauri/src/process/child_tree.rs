// Child-process inspection for terminal tabs (FR-012, FR-013): does a shell have a running child, and kill a
// shell with everything below it. Descendants are matched by parent pid plus the creation-time check
// `pid_records.rs` applies, so a recycled pid is never mistaken for a child. The ConPTY host
// (`conhost.exe` / `OpenConsole.exe`) is not a child the user started, so it is never counted.

/// Console host images ConPTY runs; excluded by name from "has a child".
const CONSOLE_HOSTS: [&str; 2] = ["conhost.exe", "openconsole.exe"];

pub fn is_console_host(image: &str) -> bool {
    CONSOLE_HOSTS
        .iter()
        .any(|host| image.eq_ignore_ascii_case(host))
}

/// True when `root_pid` has a live descendant other than the console host.
pub fn has_child_process(root_pid: u32) -> bool {
    imp::has_child_process(root_pid)
}

/// Terminates every descendant of `root_pid`, then the root itself. Best effort: a process that is
/// already gone, or that this user may not terminate, is skipped.
pub fn kill_tree(root_pid: u32) {
    imp::kill_tree(root_pid);
}

#[cfg(target_os = "windows")]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    use super::is_console_host;

    struct Entry {
        pid: u32,
        ppid: u32,
        image: String,
    }

    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            // Safety: `self.0` came from `OpenProcess` and is closed only here.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn snapshot() -> Vec<Entry> {
        // Safety: one documented API call; the snapshot handle is closed through the guard.
        let Ok(handle) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return Vec::new();
        };
        let _guard = HandleGuard(handle);
        let mut entries = Vec::new();
        let mut raw = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // Safety: `raw` is `dwSize`-stamped as the API requires and outlives both calls.
        unsafe {
            if Process32FirstW(handle, &mut raw).is_ok() {
                loop {
                    let end = raw
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(raw.szExeFile.len());
                    entries.push(Entry {
                        pid: raw.th32ProcessID,
                        ppid: raw.th32ParentProcessID,
                        image: String::from_utf16_lossy(&raw.szExeFile[..end]),
                    });
                    if Process32NextW(handle, &mut raw).is_err() {
                        break;
                    }
                }
            }
        }
        entries
    }

    fn open(pid: u32) -> Option<(HandleGuard, u64)> {
        if pid == 0 {
            return None;
        }
        // Safety: one handle serves the creation-time read and any later terminate, closed once.
        let handle = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .ok()?;
        let guard = HandleGuard(handle);
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        // Safety: the four out-parameters are locals that outlive the call.
        unsafe { GetProcessTimes(guard.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            .ok()?;
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        Some((guard, ticks))
    }

    /// Visits every live descendant of `root_pid`, parents before children, until `visit` returns false.
    /// A candidate created before its parent is a recycled pid and is skipped with its subtree.
    fn walk(root_pid: u32, mut visit: impl FnMut(&Entry, HANDLE) -> bool) {
        let Some((_root, root_ticks)) = open(root_pid) else {
            return;
        };
        let entries = snapshot();
        let mut frontier = vec![(root_pid, root_ticks)];
        let mut seen = std::collections::HashSet::from([root_pid]);
        while let Some((parent, parent_ticks)) = frontier.pop() {
            for entry in entries.iter().filter(|entry| entry.ppid == parent) {
                if !seen.insert(entry.pid) {
                    continue;
                }
                let Some((guard, ticks)) = open(entry.pid) else {
                    continue;
                };
                if ticks < parent_ticks {
                    continue;
                }
                if !visit(entry, guard.0) {
                    return;
                }
                frontier.push((entry.pid, ticks));
            }
        }
    }

    pub fn has_child_process(root_pid: u32) -> bool {
        let mut found = false;
        walk(root_pid, |entry, _| {
            found = !is_console_host(&entry.image);
            !found
        });
        found
    }

    pub fn kill_tree(root_pid: u32) {
        walk(root_pid, |_, handle| {
            // Safety: `handle` was verified against the creation time by `walk` and is still open.
            let _ = unsafe { TerminateProcess(handle, 1) };
            true
        });
        if let Some((root, _)) = open(root_pid) {
            // Safety: same handle that was just opened for this pid.
            let _ = unsafe { TerminateProcess(root.0, 1) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn has_child_process(_root_pid: u32) -> bool {
        false
    }

    pub fn kill_tree(_root_pid: u32) {}
}

#[cfg(test)]
#[path = "child_tree.test.rs"]
mod tests;
