//! Update availability, download, install-on-quit, and dependency installs.
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

/// Startup hook. Resolves a phase left from an earlier run before the automatic check.
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

/// How often Refract re-checks for a newer release while open.
pub const PERIODIC_CHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(4 * 60 * 60);

/// Debug-only override of `PERIODIC_CHECK_INTERVAL` so live checks need not wait hours.
const INTERVAL_OVERRIDE_ENV: &str = "REFRACT_UPDATE_CHECK_INTERVAL_SECS";

/// Pure for testing; release builds ignore the override.
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

/// Skips the tick while work is in flight or a verified installer already waits.
fn should_run_cycle(phase: state::UpdatePhase) -> bool {
    !matches!(
        phase,
        state::UpdatePhase::Checking
            | state::UpdatePhase::Downloading
            | state::UpdatePhase::Downloaded
            | state::UpdatePhase::Installing
    )
}

/// One automatic cycle: check, then download when a newer release is found.
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

/// Re-checks every `interval`, starting one interval after startup. Never returns.
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

/// Set by `updates.installNow` before quitting; process-global because the quit hook has no IPC channel.
static RESTART_AFTER_INSTALL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn request_restart_after_install() {
    RESTART_AFTER_INSTALL.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Set by the first `ExitRequested`, so a repeated close does not run the hand-off twice (#1175).
static QUIT_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True only for the first caller; every later one is a repeat and must do nothing.
pub fn begin_quit() -> bool {
    !QUIT_IN_PROGRESS.swap(true, std::sync::atomic::Ordering::SeqCst)
}

/// Pre-flight for `updates.installNow`: fails over IPC before quitting, so the app stays open.
pub async fn verify_downloaded_installer(
    store: &SharedUpdateState,
    updates_dir: &Path,
) -> Result<(), (installer::UpdateErrorCode, String)> {
    let not_ready = || {
        (
            installer::UpdateErrorCode::UpdateUnavailable,
            "No downloaded update is ready to install.".to_string(),
        )
    };
    let installer_path = {
        let guard = store.lock().await;
        let current = guard.get();
        if current.phase != state::UpdatePhase::Downloaded {
            return Err(not_ready());
        }
        current.installer_path.clone().ok_or_else(not_ready)?
    };
    match tokio::time::timeout(
        VERIFY_AND_SCHEDULE_TIMEOUT,
        install_on_quit::verify_installer_before_quit(
            &std::path::PathBuf::from(installer_path),
            updates_dir,
        ),
    )
    .await
    {
        Ok(result) => {
            result.map_err(|reason| (installer::UpdateErrorCode::ChecksumMismatch, reason))
        }
        Err(_) => Err((
            installer::UpdateErrorCode::UpdateUnavailable,
            "Verifying the update timed out.".to_string(),
        )),
    }
}

/// Bounds the re-hash and WMI hand-off so quitting never hangs.
const VERIFY_AND_SCHEDULE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Quit hook: installs only when `Downloaded`. The lock is dropped before the slow re-hash.
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
            // The WMI call may have succeeded before this timeout, so stay at `Installing`.
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
