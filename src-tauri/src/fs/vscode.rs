// Resolves Code.exe from fixed install roots, never via PATH: `code.cmd` cannot be spawned
// without `shell: true`, which is an argument-injection risk.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex as StdMutex};

async fn file_exists(candidate: &std::path::Path) -> bool {
    tokio::fs::try_exists(candidate).await.unwrap_or(false)
}

static CACHE: LazyLock<StdMutex<Option<PathBuf>>> = LazyLock::new(|| StdMutex::new(None));

fn cache() -> &'static StdMutex<Option<PathBuf>> {
    &CACHE
}

/// Clears the cached resolution after a spawn fails asynchronously (uninstalled, moved, EACCES).
/// Otherwise every later open would reuse the stale path.
pub fn clear_vscode_executable_cache() {
    *cache().lock().expect("vscode cache mutex poisoned") = None;
}

/// Resolves `Code.exe`: per-user install first, then system installs; `None` when absent.
/// Only successes are cached, so a mid-session install is picked up without a restart.
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
        // Does not call `resolve_vscode_executable`: that would race with the process-wide env vars.
        // Asserts only that the cache-clear primitive empties the slot.
        clear_vscode_executable_cache();
        assert!(cache().lock().unwrap().is_none());
    }
}
