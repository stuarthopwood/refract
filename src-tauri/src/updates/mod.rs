// Rust port of spec 006 ("Installer and updates") re-scoped onto the Tauri bundler (lane R11b,
// issue #794, epic #797): the dependency-install and update-availability/download/install-on-quit
// machinery this build owns. `installerHooks.nsh`/`tauri.conf.json`'s `bundle.windows` section
// (the packaging/uninstall half of spec 006) live outside this module, at the crate root and
// `src-tauri/` respectively.
//
// Module split, each file self-contained apart from the dependency edges noted below:
// - `state`: `UpdateState`/`UpdateStateStore`, persisted `updateState.json`.
// - `gh_client`: a minimal, independent `gh` CLI wrapper (deliberately NOT a dependency of
//   `src-tauri/src/github/`, pre-declared for a different, still in-flight lane).
// - `checker`: `check_for_updates` (depends on `state`, `gh_client`).
// - `installer`: `download_update` (depends on `state`, `gh_client`).
// - `install_on_quit`: the WMI-breakaway install-on-quit mechanism, and the startup leftover-state
//   resolver (depends on `state`).
// - `dependency_install`: `install_git`/`install_omp`/`install_github_cli`, the first-run
//   readiness checklist's Install actions (self-contained; no dependency on the other files here).
pub mod checker;
pub mod dependency_install;
mod dependency_install_http;
pub mod gh_client;
pub mod install_on_quit;
pub mod installer;
pub mod state;

use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

/// `lib.rs`'s own `setup` closure hook (contracts/ipc.md "Startup behaviour", FR-020/SC-010):
/// kicked off after the window is shown. Resolves a leftover `installing` phase from the
/// previous run (FR-018) before the automatic check, which must never clobber what that
/// resolution just decided -- held under the one store lock for both steps so the automatic
/// check always sees the resolved phase, never a stale `installing` from a concurrent reader.
/// Returns the renderer-safe final state for the caller to broadcast; factored out of `lib.rs`
/// itself (`AGENTS.md` "No god files") rather than inlined in its `setup` closure.
pub async fn run_startup_update_check(
    store: &Arc<AsyncMutex<state::UpdateStateStore>>,
    current_version: &str,
) -> state::UpdateState {
    let mut guard = store.lock().await;
    install_on_quit::resolve_installing_state(&mut guard, current_version).await;
    checker::check_for_updates(&mut guard, true, current_version).await
}

/// `lib.rs`'s own `ExitRequested` hook (FR-015/FR-016): runs after every live agent has already
/// been asked to stop, so install-on-quit never interrupts a running agent. A `phase` other
/// than `Downloaded` is a no-op (data-model.md: "A `before-quit` that fires while `phase` is
/// anything other than `'downloaded'` does nothing update-related"). Persists `Installing` on a
/// successful hand-off, or `Failed` with an actionable `last_error` otherwise -- the app is
/// already quitting either way, so there is nothing further for the caller to branch on.
pub async fn run_install_on_quit_hook(
    store: &Arc<AsyncMutex<state::UpdateStateStore>>,
    updates_dir: &Path,
) {
    let mut guard = store.lock().await;
    let current = guard.get();
    if current.phase != state::UpdatePhase::Downloaded {
        return;
    }
    let Some(installer_path) = current.installer_path.clone() else {
        return;
    };
    let installer_path = std::path::PathBuf::from(installer_path);
    let outcome =
        match install_on_quit::verify_installer_before_quit(&installer_path, updates_dir).await {
            Ok(()) => {
                install_on_quit::schedule_install_on_quit(&installer_path, std::process::id()).await
            }
            Err(reason) => Err(reason),
        };
    match outcome {
        Ok(()) => {
            guard
                .update(|s| s.phase = state::UpdatePhase::Installing)
                .await;
        }
        Err(reason) => {
            log::error!("install-on-quit failed: {reason}");
            guard
                .update(|s| {
                    s.phase = state::UpdatePhase::Failed;
                    s.last_error = Some(reason);
                })
                .await;
        }
    }
}
