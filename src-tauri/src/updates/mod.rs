// Rust port of spec 006 ("Installer and updates") re-scoped onto the Tauri bundler (lane R11b,
// issue #794, epic #797): the dependency-install and update-availability/download/install-on-quit
// machinery this build owns. `installerHooks.nsh`/`tauri.conf.json`'s `bundle.windows` section
// (the packaging/uninstall half of spec 006) live outside this module, at the crate root and
// `src-tauri/` respectively.
//
// Module split, each file self-contained apart from the dependency edges noted below:
// - `state`: `UpdateState`/`UpdateStateStore`/`SharedUpdateState`, persisted `updateState.json`.
// - `gh_client`: a minimal `gh` CLI wrapper, sharing `github::gh::resolve_gh` (the actual process
//   spawn/timeout/JSON-parse shape differs enough -- a configurable timeout for the installer's
//   multi-minute download -- to stay its own small file rather than fold into `github::gh`).
// - `checker`: `check_for_updates` (depends on `state`, `gh_client`).
// - `installer`: `download_update` (depends on `state`, `gh_client`, `checksum`).
// - `checksum`: shared streamed SHA-256 verify (depends on nothing in this module).
// - `install_on_quit`: the WMI-breakaway install-on-quit mechanism, and the startup leftover-state
//   resolver (depends on `state`, `checksum`).
// - `dependency_install` (+ `dependency_install_http`): `install_git`/`install_omp`/
//   `install_github_cli`, the first-run readiness checklist's Install actions (self-contained).
pub mod checker;
pub mod checksum;
pub mod dependency_install;
mod dependency_install_http;
pub mod gh_client;
pub mod install_on_quit;
pub mod installer;
pub mod state;

use std::path::Path;

use state::{SharedUpdateState, UpdateState};

/// `lib.rs`'s own `setup` closure hook (contracts/ipc.md "Startup behaviour", FR-020/SC-010):
/// kicked off after the window is shown. Resolves any phase left over from a run that quit
/// before it finished (FR-018, and the `Downloading`/`Checking` gate hardening --
/// `install_on_quit::resolve_startup_state`'s own doc comment) before the automatic check, which
/// must never clobber what that resolution just decided -- these two steps still run back-to-
/// back so the automatic check always sees the just-resolved phase, but `resolve_startup_state`
/// now only holds the lock for its own (local-disk-only, no network) body; `check_for_updates`
/// manages its own lock/unlock around the network calls it makes (gate finding, PR #829 round 1,
/// perf HIGH: the lock used to be held by this caller across the WHOLE check, including every
/// `gh` call). Returns the renderer-safe final state for the caller to broadcast; factored out of
/// `lib.rs` itself (`AGENTS.md` "No god files") rather than inlined in its `setup` closure.
pub async fn run_startup_update_check(
    store: &SharedUpdateState,
    current_version: &str,
    on_state: &(dyn Fn(&UpdateState) + Send + Sync),
) -> UpdateState {
    {
        let mut guard = store.lock().await;
        install_on_quit::resolve_startup_state(&mut guard, current_version).await;
    }
    checker::check_for_updates(store, true, current_version, on_state).await
}

/// `lib.rs`'s own `ExitRequested` hook (FR-015/FR-016): runs after every live agent has already
/// been asked to stop, so install-on-quit never interrupts a running agent. A `phase` other
/// than `Downloaded` is a no-op (data-model.md: "A `before-quit` that fires while `phase` is
/// anything other than `'downloaded'` does nothing update-related"). Persists `Installing` on a
/// successful hand-off, or `Failed` with an actionable `last_error` otherwise -- the app is
/// already quitting either way, so there is nothing further for the caller to branch on.
///
/// Gate finding (PR #829 round 1, perf HIGH, "bound the quit hook's lock wait"): the lock
/// acquisition itself is bounded -- a timed-out acquisition skips the hook entirely (logged): the
/// app still quits, and the next launch's own `resolve_startup_state`/automatic check settle
/// whatever `updateState.json` was left with.
///
/// Gate finding (round 2, HIGH "bound the quit hook's verify-and-schedule step"): the lock is
/// read once to decide whether there is anything to do, then DROPPED before the re-hash (a
/// ~146MB streamed read) and the WMI hand-off run -- neither is network I/O, but both are
/// filesystem/process work this function must not make every other `updates::` caller
/// (`updates.getState`/a concurrent `updates.check`) wait on, matching every other lock/await
/// split this module already makes (`checker::check_for_updates`, `installer::download_update`).
/// The combined verify+schedule step is additionally bounded by its own timeout: quitting must
/// never hang indefinitely even if a hash read stalls on a failing disk or the WMI call never
/// returns.
const VERIFY_AND_SCHEDULE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub async fn run_install_on_quit_hook(store: &SharedUpdateState, updates_dir: &Path) {
    let installer_path = {
        let guard = match tokio::time::timeout(std::time::Duration::from_secs(5), store.lock())
            .await
        {
            Ok(guard) => guard,
            Err(_) => {
                log::error!(
                    "install-on-quit: timed out waiting for the update-state lock; skipping"
                );
                return;
            }
        };
        let current = guard.get();
        if current.phase != state::UpdatePhase::Downloaded {
            return;
        }
        let Some(installer_path) = current.installer_path.clone() else {
            return;
        };
        std::path::PathBuf::from(installer_path)
    };

    let outcome = match tokio::time::timeout(
        VERIFY_AND_SCHEDULE_TIMEOUT,
        verify_and_schedule(&installer_path, updates_dir),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => Err("verifying and scheduling the install timed out".to_string()),
    };

    let mut guard = match tokio::time::timeout(std::time::Duration::from_secs(5), store.lock())
        .await
    {
        Ok(guard) => guard,
        Err(_) => {
            log::error!(
                "install-on-quit: timed out waiting for the update-state lock to commit the outcome; skipping"
            );
            return;
        }
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

async fn verify_and_schedule(installer_path: &Path, updates_dir: &Path) -> Result<(), String> {
    install_on_quit::verify_installer_before_quit(installer_path, updates_dir).await?;
    install_on_quit::schedule_install_on_quit(installer_path, std::process::id()).await
}
