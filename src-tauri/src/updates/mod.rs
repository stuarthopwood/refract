// Rust port of spec 006 ("Installer and updates") re-scoped onto the Tauri bundler (lane R11b,
// issue #794, epic #797): the dependency-install and update-availability/download/install-on-quit
// machinery this build owns. `installerHooks.nsh`/`tauri.conf.json`'s `bundle.windows` section
// (the packaging/uninstall half of spec 006) live outside this module, at the crate root and
// `src-tauri/` respectively.
//
// Module split, each file self-contained apart from the dependency edges noted below:
// - `state`: `UpdateState`/`UpdateStateStore`/`SharedUpdateState`, persisted `updateState.json`.
// - `gh_client`: the update-specific `GithubCliStatus`/`github_cli_status`/offline-text-matching
//   only -- shares `github::gh::gh_raw`/`gh_json` directly (gate finding, PR #829 round 2)
//   rather than duplicating them.
// - `checker`: `check_for_updates` (depends on `state`, `gh_client`).
// - `installer`: `download_update` (depends on `state`, `gh_client`, `checksum`).
// - `checksum`: shared streamed SHA-256 verify (depends on nothing in this module).
// - `signature` (lane R11d, follow-up to #794): `WinVerifyTrust`-based Authenticode signature
//   verification plus the pinned signer-certificate check (depends on nothing in this module).
// - `install_on_quit`: the WMI-breakaway install-on-quit mechanism, and the startup leftover-state
//   resolver (depends on `state`, `checksum`, `signature`).
// - `dependency_install` (+ `dependency_install_http`): `install_git`/`install_omp`/
//   `install_github_cli`, the first-run readiness checklist's Install actions (self-contained).
pub mod checker;
pub mod checksum;
pub mod dependency_install;
mod dependency_install_http;
pub mod gh_client;
pub mod install_on_quit;
pub mod installer;
pub mod signature;
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
///
/// Gate finding (round 3, Medium): `resolve_startup_state`'s own result used to be discarded here
/// -- a resolution to `Failed` (a leftover `Installing` mismatch, or the new `Downloading`
/// hardening) is a phase the automatic `check_for_updates` call right after it then SKIPS
/// entirely (its own `automatic && Failed` no-op guard), so `on_state` was never called for it:
/// the window would already be showing a renderer that never heard about the resolution until
/// its next unrelated poll. `on_state` is now called with the resolved state directly, before the
/// automatic check ever runs.
pub async fn run_startup_update_check(
    store: &SharedUpdateState,
    data_dir: &Path,
    current_version: &str,
    on_state: &(dyn Fn(&UpdateState) + Send + Sync),
) -> UpdateState {
    let resolved = {
        let mut guard = store.lock().await;
        install_on_quit::resolve_startup_state(&mut guard, current_version).await
    };
    on_state(&resolved);
    run_update_cycle(store, data_dir, current_version, on_state).await
}

/// FR-032: how often Refract re-checks for a newer release while it stays open.
pub const PERIODIC_CHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(4 * 60 * 60);

/// Debug-only override of `PERIODIC_CHECK_INTERVAL` (FR-032) so a live check need not wait hours.
const INTERVAL_OVERRIDE_ENV: &str = "REFRACT_UPDATE_CHECK_INTERVAL_SECS";

/// Pure so it can be tested for both build kinds: release builds (`debug == false`) always use
/// `PERIODIC_CHECK_INTERVAL`; a debug build uses a positive whole-seconds override when given.
fn resolve_check_interval(debug: bool, raw_override: Option<&str>) -> std::time::Duration {
    if !debug {
        return PERIODIC_CHECK_INTERVAL;
    }
    raw_override
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(std::time::Duration::from_secs)
        .unwrap_or(PERIODIC_CHECK_INTERVAL)
}

pub fn check_interval() -> std::time::Duration {
    resolve_check_interval(
        cfg!(debug_assertions),
        std::env::var(INTERVAL_OVERRIDE_ENV).ok().as_deref(),
    )
}

/// FR-032: a tick is skipped while a check, download, or install is in progress, and while a
/// verified installer already waits (nothing left to find).
fn should_run_cycle(phase: state::UpdatePhase) -> bool {
    !matches!(
        phase,
        state::UpdatePhase::Checking
            | state::UpdatePhase::Downloading
            | state::UpdatePhase::Downloaded
            | state::UpdatePhase::Installing
    )
}

/// One automatic cycle (FR-032, FR-033): check, and download at once when a newer release is
/// found, through the same checksum and signature path as the manual install. A download failure
/// is already persisted and broadcast as `Failed` by `download_update`.
pub async fn run_update_cycle(
    store: &SharedUpdateState,
    data_dir: &Path,
    current_version: &str,
    on_state: &(dyn Fn(&UpdateState) + Send + Sync),
) -> UpdateState {
    let phase = store.lock().await.get().phase;
    if !should_run_cycle(phase) {
        return store.lock().await.get();
    }
    let checked = checker::check_for_updates(store, true, current_version, on_state).await;
    if checked.phase != state::UpdatePhase::Available {
        return checked;
    }
    if let Err(err) = installer::download_update(store, data_dir, on_state).await {
        log::warn!("automatic update download failed: {err}");
    }
    store.lock().await.get()
}

/// FR-032: re-checks every `interval` while the app runs; the first one a full interval after
/// the startup check. Never returns.
pub async fn run_periodic_update_checks(
    store: SharedUpdateState,
    data_dir: std::path::PathBuf,
    current_version: String,
    interval: std::time::Duration,
    on_state: impl Fn(&UpdateState) + Send + Sync + 'static,
) {
    loop {
        tokio::time::sleep(interval).await;
        run_update_cycle(&store, &data_dir, &current_version, &on_state).await;
    }
}

/// FR-035: set by `updates.installNow` just before it quits Refract, so the install-on-quit hook
/// relaunches Refract after the installer finishes. Process-global because the quit hook runs
/// from `lib.rs`'s own `ExitRequested` handler, with no channel back to the IPC call.
static RESTART_AFTER_INSTALL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn request_restart_after_install() {
    RESTART_AFTER_INSTALL.store(true, std::sync::atomic::Ordering::SeqCst);
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
        let guard =
            match tokio::time::timeout(std::time::Duration::from_secs(5), store.lock()).await {
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

    let relaunch = RESTART_AFTER_INSTALL
        .load(std::sync::atomic::Ordering::SeqCst)
        .then(std::env::current_exe)
        .and_then(Result::ok);
    let timeout_result = tokio::time::timeout(
        VERIFY_AND_SCHEDULE_TIMEOUT,
        verify_and_schedule(&installer_path, updates_dir, relaunch),
    )
    .await;

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
    match timeout_result {
        Ok(Ok(())) => {
            guard
                .update(|s| s.phase = state::UpdatePhase::Installing)
                .await;
        }
        Ok(Err(reason)) => {
            log::error!("install-on-quit failed: {reason}");
            guard
                .update(|s| {
                    s.phase = state::UpdatePhase::Failed;
                    s.last_error = Some(reason);
                })
                .await;
        }
        Err(_) => {
            // Gate finding (round 3, Low): the 30s budget below is this whole function's own
            // wait, not a cancellation signal `schedule_install_on_quit`'s WMI call itself ever
            // sees -- if `Win32_Process.Create` had already succeeded the instant before this
            // timeout fired, the real wait-then-install process is already running
            // independently of Refract, and writing `Failed` here would be actively wrong (it
            // overwrites a true success with a reported failure). The outcome is genuinely
            // ambiguous, so this leaves the phase at `Installing`, same as a confirmed
            // hand-off -- `install_on_quit::resolve_startup_state`'s own version-match check on
            // the next launch resolves it for real (`Idle` if the install actually happened,
            // `Failed` if it didn't), rather than this function guessing.
            log::error!(
                "install-on-quit: verify-and-schedule timed out after {VERIFY_AND_SCHEDULE_TIMEOUT:?}; leaving phase as Installing for the next launch to resolve"
            );
            guard
                .update(|s| s.phase = state::UpdatePhase::Installing)
                .await;
        }
    }
}

async fn verify_and_schedule(
    installer_path: &Path,
    updates_dir: &Path,
    relaunch: Option<std::path::PathBuf>,
) -> Result<(), String> {
    install_on_quit::verify_installer_before_quit(installer_path, updates_dir).await?;
    install_on_quit::schedule_install_on_quit(
        installer_path,
        std::process::id(),
        relaunch.as_deref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use state::UpdatePhase;

    #[test]
    fn release_builds_ignore_the_interval_override() {
        assert_eq!(
            resolve_check_interval(false, Some("5")),
            PERIODIC_CHECK_INTERVAL
        );
    }

    #[test]
    fn debug_builds_accept_a_positive_override_only() {
        assert_eq!(
            resolve_check_interval(true, Some(" 7 ")),
            std::time::Duration::from_secs(7)
        );
        for bad in [Some("0"), Some("-3"), Some("soon"), Some(""), None] {
            assert_eq!(resolve_check_interval(true, bad), PERIODIC_CHECK_INTERVAL);
        }
    }

    #[test]
    fn the_default_interval_is_four_hours() {
        assert_eq!(PERIODIC_CHECK_INTERVAL.as_secs(), 14_400);
    }

    #[test]
    fn a_tick_is_skipped_while_work_is_in_flight() {
        for busy in [
            UpdatePhase::Checking,
            UpdatePhase::Downloading,
            UpdatePhase::Downloaded,
            UpdatePhase::Installing,
        ] {
            assert!(!should_run_cycle(busy), "{busy:?} should skip the tick");
        }
        for open in [
            UpdatePhase::Idle,
            UpdatePhase::Available,
            UpdatePhase::Failed,
        ] {
            assert!(should_run_cycle(open), "{open:?} should run the tick");
        }
    }
}
