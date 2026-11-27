use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Output;

use super::*;
use crate::updates::installer::UpdateErrorCode;
use crate::updates::state::UpdatePhase;
use crate::updates::test_support::{open_store, sha256_hex, updates_dir, INSTALLER_NAME};
use crate::updates::{run_install_on_quit_hook, verify_downloaded_installer};

fn exited(code: u32, stdout: &str, stderr: &str) -> Output {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    #[cfg(unix)]
    let code = (code as i32) << 8;
    Output {
        status: std::process::ExitStatus::from_raw(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
    }
}

fn env_of(command: &Command, key: &str) -> Option<OsString> {
    command
        .as_std()
        .get_envs()
        .find(|(name, _)| *name == key)
        .and_then(|(_, value)| value.map(ToOwned::to_owned))
}

fn scratch_installer() -> PathBuf {
    let dir = crate::test_scratch::path("updates");
    std::fs::create_dir_all(&dir).expect("create updates dir");
    dir.join(INSTALLER_NAME)
}

/// Runs the scheduler against a fake launcher and returns the command it would have spawned.
async fn schedule(
    installer: &Path,
    relaunch: Option<&Path>,
    result: std::io::Result<Output>,
) -> (Result<(), String>, Option<Command>) {
    let launched = std::cell::RefCell::new(None);
    let outcome = schedule_install_with(
        |command| {
            *launched.borrow_mut() = Some(command);
            std::future::ready(result)
        },
        installer,
        "abc123",
        4242,
        relaunch,
    )
    .await;
    (outcome, launched.into_inner())
}

#[tokio::test]
async fn the_hand_off_passes_the_verified_installer_and_pid_to_the_helper_by_environment() {
    let installer = scratch_installer();

    let (outcome, command) = schedule(&installer, None, Ok(exited(0, "", ""))).await;

    outcome.expect("hand-off succeeds");
    let command = command.expect("helper launched");
    assert_eq!(
        env_of(&command, "REFRACT_INSTALLER_PATH"),
        Some(installer.clone().into_os_string())
    );
    assert_eq!(
        env_of(&command, "REFRACT_INSTALLER_SHA256"),
        Some("abc123".into())
    );
    assert_eq!(env_of(&command, "REFRACT_WAIT_PID"), Some("4242".into()));
    assert_eq!(env_of(&command, "REFRACT_RELAUNCH_PATH"), None);
}

#[tokio::test]
async fn the_installer_path_never_appears_in_the_script_text() {
    let installer = scratch_installer();

    let (_, command) = schedule(&installer, None, Ok(exited(0, "", ""))).await;

    let command = command.expect("helper launched");
    let installer_text = installer.to_string_lossy().into_owned();
    for arg in command.as_std().get_args() {
        assert!(!arg.to_string_lossy().contains(&installer_text));
    }
}

#[tokio::test]
async fn a_restart_request_hands_the_relaunch_target_to_the_helper() {
    let installer = scratch_installer();
    let app = PathBuf::from("C:/Refract/refract.exe");

    let (_, command) = schedule(&installer, Some(&app), Ok(exited(0, "", ""))).await;

    let command = command.expect("helper launched");
    assert_eq!(
        env_of(&command, "REFRACT_RELAUNCH_PATH"),
        Some(app.into_os_string())
    );
}

#[tokio::test]
async fn a_new_attempt_replaces_the_stale_result_in_the_install_log() {
    let installer = scratch_installer();
    let log = install_log_path(&installer);
    std::fs::write(&log, "1 result: exit=0\n").expect("seed stale log");

    schedule(&installer, None, Ok(exited(0, "", "")))
        .await
        .0
        .expect("ok");

    let text = std::fs::read_to_string(&log).expect("read log");
    assert!(text.contains("scheduled: installer="));
    assert!(
        !text.contains("result: exit=0"),
        "stale result must not be read as this run's"
    );
}

#[tokio::test]
async fn a_failed_hand_off_reports_the_exit_code_and_stderr_and_logs_it() {
    let installer = scratch_installer();

    let (outcome, _) = schedule(&installer, None, Ok(exited(1, "", "Access is denied\n"))).await;

    let err = outcome.unwrap_err();
    assert!(err.contains("exit 1"), "{err}");
    assert!(err.contains("Access is denied"), "{err}");
    let text = std::fs::read_to_string(install_log_path(&installer)).expect("read log");
    assert!(text.contains("hand-off failed: exit=1"), "{text}");
}

#[tokio::test]
async fn a_silent_hand_off_failure_still_names_the_exit_code() {
    let installer = scratch_installer();

    let (outcome, _) = schedule(&installer, None, Ok(exited(3, "", ""))).await;

    assert_eq!(
        outcome.unwrap_err(),
        "install-on-quit hand-off failed (exit 3)."
    );
}

#[tokio::test]
async fn a_helper_that_cannot_start_is_reported_not_swallowed() {
    let installer = scratch_installer();
    let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "powershell.exe not found");

    let (outcome, _) = schedule(&installer, None, Err(missing)).await;

    assert!(outcome.unwrap_err().contains("powershell.exe not found"));
}

#[tokio::test]
async fn scheduling_fails_cleanly_when_the_log_directory_is_missing() {
    let installer = crate::test_scratch::path("no-such-dir").join(INSTALLER_NAME);

    let (outcome, command) = schedule(&installer, None, Ok(exited(0, "", ""))).await;

    assert!(outcome.unwrap_err().contains("could not write"));
    assert!(
        command.is_none(),
        "nothing is launched when the log cannot be written"
    );
}

#[tokio::test]
async fn quitting_without_a_downloaded_update_changes_nothing() {
    for phase in [
        UpdatePhase::Idle,
        UpdatePhase::Available,
        UpdatePhase::Downloading,
        UpdatePhase::Installing,
        UpdatePhase::Failed,
    ] {
        let (store, dir) = open_store(|s| {
            s.phase = phase;
            s.installer_path = Some("never-run.exe".to_string());
        })
        .await;

        run_install_on_quit_hook(&store, &updates_dir(&dir)).await;

        let state = store.lock().await.get();
        assert_eq!(state.phase, phase);
        assert_eq!(state.last_error, None);
    }
}

#[tokio::test]
async fn a_downloaded_phase_with_no_installer_path_is_left_alone() {
    let (store, dir) = open_store(|s| s.phase = UpdatePhase::Downloaded).await;

    run_install_on_quit_hook(&store, &updates_dir(&dir)).await;

    assert_eq!(store.lock().await.get().phase, UpdatePhase::Downloaded);
}

async fn downloaded_with_tampered_installer() -> (crate::updates::state::SharedUpdateState, PathBuf)
{
    let (store, dir) = open_store(|_| {}).await;
    let updates = updates_dir(&dir);
    std::fs::create_dir_all(&updates).expect("create updates dir");
    let installer = updates.join(INSTALLER_NAME);
    std::fs::write(&installer, b"swapped after download").expect("write installer");
    std::fs::write(
        sha256_sibling(&installer),
        format!("{}  {INSTALLER_NAME}\n", sha256_hex(b"what was verified")),
    )
    .expect("write checksum");
    let path = installer.to_string_lossy().into_owned();
    store
        .lock()
        .await
        .update(|s| {
            s.phase = UpdatePhase::Downloaded;
            s.installer_path = Some(path);
        })
        .await;
    (store, dir)
}

#[tokio::test]
async fn quitting_refuses_an_installer_that_changed_since_it_was_verified() {
    let (store, dir) = downloaded_with_tampered_installer().await;

    run_install_on_quit_hook(&store, &updates_dir(&dir)).await;

    let state = store.lock().await.get();
    assert_eq!(state.phase, UpdatePhase::Failed);
    assert!(state
        .last_error
        .as_deref()
        .is_some_and(|err| err.contains("no longer matches its published checksum")));
    assert!(
        !install_log_path(&updates_dir(&dir).join(INSTALLER_NAME)).exists(),
        "no helper was scheduled"
    );
}

#[tokio::test]
async fn install_now_is_refused_before_quitting_when_nothing_is_downloaded() {
    let (store, dir) = open_store(|s| s.phase = UpdatePhase::Available).await;

    let (code, message) = verify_downloaded_installer(&store, &updates_dir(&dir))
        .await
        .unwrap_err();

    assert_eq!(code, UpdateErrorCode::UpdateUnavailable);
    assert_eq!(message, "No downloaded update is ready to install.");
}

#[tokio::test]
async fn install_now_is_refused_when_the_installer_was_tampered_with() {
    let (store, dir) = downloaded_with_tampered_installer().await;

    let (code, message) = verify_downloaded_installer(&store, &updates_dir(&dir))
        .await
        .unwrap_err();

    assert_eq!(code, UpdateErrorCode::ChecksumMismatch);
    assert!(message.contains("no longer matches"), "{message}");
}

#[tokio::test]
async fn install_now_is_refused_for_an_installer_outside_the_updates_directory() {
    let (store, dir) = open_store(|_| {}).await;
    let elsewhere = dir.join(INSTALLER_NAME);
    std::fs::write(&elsewhere, b"outside").expect("write installer");
    let path = elsewhere.to_string_lossy().into_owned();
    store
        .lock()
        .await
        .update(|s| {
            s.phase = UpdatePhase::Downloaded;
            s.installer_path = Some(path);
        })
        .await;

    let (code, message) = verify_downloaded_installer(&store, &updates_dir(&dir))
        .await
        .unwrap_err();

    assert_eq!(code, UpdateErrorCode::ChecksumMismatch);
    assert!(message.contains("not directly inside"), "{message}");
}
