use std::sync::Mutex;

use super::*;
use state::{UnavailableReason, UpdatePhase};
use test_support::{calls_starting_with, open_store, sha256_hex, updates_dir, FakeGh, Release};

fn no_op(_: &UpdateState) {}

#[tokio::test]
async fn a_cycle_on_the_latest_version_stays_idle_and_downloads_nothing() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v1.0.0")]).install();
    let (store, dir) = open_store(|_| {}).await;

    let state = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Idle);
    assert_eq!(state.available_version, None);
    assert_eq!(calls_starting_with(&calls, &["release", "download"]), 0);
}

#[tokio::test]
async fn a_cycle_that_finds_a_corrupt_download_ends_failed_with_no_installer_kept() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v1.1.0")])
        .serving(b"installer bytes", &sha256_hex(b"something else"))
        .install();
    let (store, dir) = open_store(|_| {}).await;

    let state = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;

    assert_eq!(calls_starting_with(&calls, &["release", "download"]), 1);
    assert_eq!(state.phase, UpdatePhase::Failed);
    assert!(state
        .last_error
        .as_deref()
        .is_some_and(|err| err.contains("published checksum")));
    assert_eq!(state.installer_path, None);
    assert_eq!(state.available_version.as_deref(), Some("1.1.0"));
    assert!(!updates_dir(&dir).join("Refract-setup.exe").exists());
}

#[tokio::test]
async fn a_failed_cycle_keeps_its_error_until_the_user_checks_again() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v1.1.0")])
        .serving(b"installer bytes", &sha256_hex(b"something else"))
        .install();
    let (store, dir) = open_store(|_| {}).await;
    let failed = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;
    let calls_after_failure = calls.borrow().len();

    let next_tick = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;

    assert_eq!(next_tick.last_error, failed.last_error);
    assert_eq!(next_tick.phase, UpdatePhase::Failed);
    assert_eq!(calls.borrow().len(), calls_after_failure, "no silent retry");

    let manual = checker::check_for_updates(&store, false, "1.0.0", &no_op).await;
    assert_eq!(manual.phase, UpdatePhase::Available);
    assert_eq!(manual.last_error, None);
}

#[tokio::test]
async fn a_cycle_does_nothing_while_a_verified_installer_is_waiting() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v9.0.0")]).install();
    let (store, dir) = open_store(|s| {
        s.phase = UpdatePhase::Downloaded;
        s.available_version = Some("1.1.0".to_string());
        s.installer_path = Some("waiting.exe".to_string());
    })
    .await;

    let state = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Downloaded);
    assert_eq!(state.available_version.as_deref(), Some("1.1.0"));
    assert!(calls.borrow().is_empty());
}

#[tokio::test]
async fn a_signed_out_cycle_reports_why_and_never_downloads() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v9.0.0")])
        .auth_fails_with("You are not logged into any GitHub hosts.")
        .install();
    let (store, dir) = open_store(|_| {}).await;

    let state = run_update_cycle(&store, &dir, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Idle);
    assert_eq!(
        state.unavailable_reason,
        Some(UnavailableReason::NotSignedIn)
    );
    assert_eq!(calls_starting_with(&calls, &["release"]), 0);
}

#[tokio::test]
async fn the_renderer_follows_a_cycle_from_checking_through_to_the_failure() {
    let (_gh, _) = FakeGh::new(vec![Release::stable("v1.1.0")])
        .serving(b"installer bytes", &sha256_hex(b"something else"))
        .install();
    let (store, dir) = open_store(|_| {}).await;
    let seen = Mutex::new(Vec::new());

    run_update_cycle(&store, &dir, "1.0.0", &|state: &UpdateState| {
        seen.lock().unwrap().push(state.phase)
    })
    .await;

    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            UpdatePhase::Checking,
            UpdatePhase::Available,
            UpdatePhase::Downloading,
            UpdatePhase::Failed,
        ]
    );
}
