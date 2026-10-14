// Port of `src/main/process/executables.ts`'s own `resolveVSCodeExecutable`/
// `clearVSCodeExecutableCache` (lane R7, issue #790): resolves VS Code's `Code.exe` by checking
// fixed known install roots directly, never via a PATH/`code.cmd` search -- `code`'s own PATH
// entry is a batch wrapper (`code.cmd`), which cannot be spawned without `shell: true`
// (argument-injection risk via `& | ^ %` in a filename). Lives under `fs/` (my own lane's glob),
// not `process::executables` (owned by an earlier, already-merged lane), so this stays a
// same-lane-only file edit rather than a cross-lane one for one small resolver.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex as StdMutex};

async fn file_exists(candidate: &std::path::Path) -> bool {
    tokio::fs::try_exists(candidate).await.unwrap_or(false)
}

static CACHE: LazyLock<StdMutex<Option<PathBuf>>> = LazyLock::new(|| StdMutex::new(None));

fn cache() -> &'static StdMutex<Option<PathBuf>> {
    &CACHE
}

/// Clears the cached, previously-successful VS Code resolution: a spawn can still fail
/// asynchronously AFTER this cache was populated (VS Code uninstalled or moved mid-run, `EACCES`,
/// antivirus quarantine) -- without clearing it, every later `openInVSCode` call would keep
/// returning the same now-stale path. Called from `ipc::file_explorer`'s own spawn-error handler.
pub fn clear_vscode_executable_cache() {
    *cache().lock().expect("vscode cache mutex poisoned") = None;
}

/// Resolves VS Code's `Code.exe`, checking in order: the default one-click per-user install
/// under `%LOCALAPPDATA%`, then the system installs under `%ProgramFiles%` and
/// `%ProgramFiles(x86)%`. Returns `None` (never errors) when none exist -- VS Code's absence is
/// an expected, normal state (the "VS Code not found" UI state), not an error condition.
///
/// Caches only a successful resolution; a negative result is deliberately NOT cached -- the check
/// is three cheap existence probes, and caching "not found" forever would require a Refract
/// restart after a user installs VS Code mid-session to ever pick up the new install.
pub async fn resolve_vscode_executable() -> Option<PathBuf> {
    if let Some(cached) = cache().lock().expect("vscode cache mutex poisoned").clone() {
        return Some(cached);
    }

    let candidates: Vec<Option<PathBuf>> = vec![
        std::env::var("LOCALAPPDATA").ok().map(|root| {
            PathBuf::from(root)
                .join("Programs")
                .join("Microsoft VS Code")
                .join("Code.exe")
        }),
        std::env::var("ProgramFiles").ok().map(|root| {
            PathBuf::from(root)
                .join("Microsoft VS Code")
                .join("Code.exe")
        }),
        std::env::var("ProgramFiles(x86)").ok().map(|root| {
            PathBuf::from(root)
                .join("Microsoft VS Code")
                .join("Code.exe")
        }),
    ];

    for candidate in candidates.into_iter().flatten() {
        if file_exists(&candidate).await {
            *cache().lock().expect("vscode cache mutex poisoned") = Some(candidate.clone());
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clear_vscode_executable_cache_empties_the_cache_slot() {
        // Does NOT call `resolve_vscode_executable` itself (gate round 1 fix: the previous name
        // implied it did, and asserting against the real, process-wide `LOCALAPPDATA`/
        // `ProgramFiles` env vars would race with any other test or live run that populates this
        // same cache in the same test binary) -- this only proves the cache-clear primitive
        // itself empties the slot, which is the one thing safe to assert without controlling
        // the real environment or serialising against concurrent callers.
        clear_vscode_executable_cache();
        assert!(cache().lock().unwrap().is_none());
    }
}
