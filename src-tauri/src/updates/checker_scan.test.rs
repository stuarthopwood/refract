use std::sync::Mutex;

use super::*;
use crate::updates::state::UnavailableReason;
use crate::updates::test_support::{calls_starting_with, open_store, FakeGh, Release};

fn no_op(_: &UpdateState) {}

#[tokio::test]
async fn the_newest_stable_release_is_offered_whatever_order_gh_lists_them() {
    let (_gh, _) = FakeGh::new(vec![
        Release::stable("v1.1.0"),
        Release::stable("v1.3.0"),
        Release::stable("v1.2.0"),
    ])
    .install();
    let (store, _dir) = open_store(|_| {}).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Available);
    assert_eq!(state.available_version.as_deref(), Some("1.3.0"));
    assert_eq!(
        state.notes_url.as_deref(),
        Some("https://github.com/stuarthopwood/refract/releases/tag/v1.3.0")
    );
    assert!(state.last_checked_at.is_some());
}

#[tokio::test]
async fn drafts_and_prereleases_are_never_offered() {
    let (_gh, _) = FakeGh::new(vec![
        Release::stable("v2.0.0").draft(),
        Release::stable("v1.5.0").prerelease(),
        Release::stable("v1.1.0"),
    ])
    .install();
    let (store, _dir) = open_store(|_| {}).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.available_version.as_deref(), Some("1.1.0"));
}

#[tokio::test]
async fn a_release_missing_its_checksum_or_installer_falls_back_to_the_next_newest() {
    let (_gh, _) = FakeGh::new(vec![
        Release::stable("v1.4.0").assets(&["Refract-setup.exe"]),
        Release::stable("v1.3.0").assets(&["Refract-setup.exe.sha256"]),
        Release::stable("v1.2.0"),
    ])
    .install();
    let (store, _dir) = open_store(|_| {}).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.available_version.as_deref(), Some("1.2.0"));
}

#[tokio::test]
async fn running_the_newest_release_leaves_nothing_available() {
    let (_gh, _) =
        FakeGh::new(vec![Release::stable("v1.2.0"), Release::stable("v1.1.0")]).install();
    let (store, _dir) = open_store(|s| {
        s.available_version = Some("1.1.0".to_string());
        s.notes_url = Some("stale".to_string());
    })
    .await;

    let state = check_for_updates(&store, false, "1.2.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Idle);
    assert_eq!(state.available_version, None);
    assert_eq!(state.notes_url, None);
    assert!(state.last_checked_at.is_some());
    assert_eq!(state.unavailable_reason, None);
}

#[tokio::test]
async fn a_signed_out_gh_reports_not_signed_in_and_never_lists_releases() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v9.0.0")])
        .auth_fails_with("You are not logged into any GitHub hosts. Run gh auth login")
        .install();
    let (store, _dir) = open_store(|_| {}).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Idle);
    assert_eq!(
        state.unavailable_reason,
        Some(UnavailableReason::NotSignedIn)
    );
    assert_eq!(calls_starting_with(&calls, &["release"]), 0);
}

#[tokio::test]
async fn an_unreachable_github_reports_offline() {
    let (_gh, _) = FakeGh::new(vec![])
        .auth_fails_with("dial tcp: lookup api.github.com: no such host: ENOTFOUND")
        .install();
    let (store, _dir) = open_store(|_| {}).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.unavailable_reason, Some(UnavailableReason::Offline));
}

#[tokio::test]
async fn a_failing_release_list_is_reported_unavailable_without_a_stale_offer() {
    let (_gh, _) = FakeGh::new(vec![])
        .list_fails_with("HTTP 502: bad gateway")
        .install();
    let (store, _dir) = open_store(|s| s.available_version = Some("1.1.0".to_string())).await;

    let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

    assert_eq!(state.phase, UpdatePhase::Idle);
    assert_eq!(state.unavailable_reason, Some(UnavailableReason::Offline));
    assert_eq!(state.available_version, None);
}

#[tokio::test]
async fn a_check_never_clobbers_a_download_or_install_in_flight() {
    let (_gh, calls) = FakeGh::new(vec![Release::stable("v9.0.0")]).install();
    for busy in [
        UpdatePhase::Downloading,
        UpdatePhase::Downloaded,
        UpdatePhase::Installing,
    ] {
        let (store, _dir) = open_store(|s| s.phase = busy).await;

        let state = check_for_updates(&store, false, "1.0.0", &no_op).await;

        assert_eq!(state.phase, busy);
    }
    assert!(calls.borrow().is_empty(), "no gh call while busy");
}

#[tokio::test]
async fn the_automatic_check_keeps_a_failure_visible_but_a_manual_check_clears_it() {
    let (_gh, _) = FakeGh::new(vec![Release::stable("v1.1.0")]).install();
    let (store, _dir) = open_store(|s| {
        s.phase = UpdatePhase::Failed;
        s.last_error = Some("The download timed out.".to_string());
    })
    .await;

    let automatic = check_for_updates(&store, true, "1.0.0", &no_op).await;
    assert_eq!(automatic.phase, UpdatePhase::Failed);
    assert_eq!(
        automatic.last_error.as_deref(),
        Some("The download timed out.")
    );

    let manual = check_for_updates(&store, false, "1.0.0", &no_op).await;
    assert_eq!(manual.phase, UpdatePhase::Available);
    assert_eq!(manual.last_error, None);
}

#[tokio::test]
async fn a_check_reports_checking_then_the_result_to_the_renderer() {
    let (_gh, _) = FakeGh::new(vec![Release::stable("v1.1.0")]).install();
    let (store, _dir) = open_store(|_| {}).await;
    let seen = Mutex::new(Vec::new());

    check_for_updates(&store, false, "1.0.0", &|state: &UpdateState| {
        seen.lock().unwrap().push(state.phase)
    })
    .await;

    assert_eq!(
        *seen.lock().unwrap(),
        vec![UpdatePhase::Checking, UpdatePhase::Available]
    );
}
