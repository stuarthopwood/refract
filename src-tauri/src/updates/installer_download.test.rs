use std::sync::Mutex;

use super::*;
use crate::updates::test_support::{
    calls_starting_with, open_store, sha256_hex, updates_dir, Download, FakeGh, Release,
    INSTALLER_NAME,
};

fn no_op(_: &UpdateState) {}

fn available(state: &mut UpdateState) {
    state.phase = UpdatePhase::Available;
    state.available_version = Some("1.1.0".to_string());
}

fn release_with_installer() -> Vec<Release> {
    vec![Release::stable("v1.1.0")]
}

#[tokio::test]
async fn refuses_to_download_when_no_update_is_available() {
    let (_gh, calls) = FakeGh::new(release_with_installer()).install();
    let (store, dir) = open_store(|_| {}).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert_eq!(err.code, UpdateErrorCode::UpdateUnavailable);
    assert!(calls.borrow().is_empty());
    assert_eq!(store.lock().await.get().phase, UpdatePhase::Idle);
}

#[tokio::test]
async fn a_checksum_mismatch_fails_the_update_and_leaves_no_installer_behind() {
    let (_gh, _) = FakeGh::new(release_with_installer())
        .serving(b"installer bytes", &sha256_hex(b"different bytes"))
        .install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert_eq!(err.code, UpdateErrorCode::ChecksumMismatch);
    assert!(err.message.contains("did not match its published checksum"));
    let state = store.lock().await.get();
    assert_eq!(state.phase, UpdatePhase::Failed);
    assert_eq!(state.last_error.as_deref(), Some(err.message.as_str()));
    assert_eq!(state.installer_path, None);
    assert!(!updates_dir(&dir).join(INSTALLER_NAME).exists());
    assert!(!updates_dir(&dir)
        .join(format!("{INSTALLER_NAME}.sha256"))
        .exists());
}

#[tokio::test]
async fn an_installer_that_fails_the_signature_check_is_deleted_not_kept() {
    // The bytes match their checksum, so only the signature check can reject them.
    let bytes = b"not a signed installer";
    let (_gh, _) = FakeGh::new(release_with_installer())
        .serving(bytes, &sha256_hex(bytes))
        .install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(
        !err.message.contains("published checksum"),
        "{}",
        err.message
    );
    let state = store.lock().await.get();
    assert_eq!(state.phase, UpdatePhase::Failed);
    assert_eq!(state.installer_path, None);
    assert!(!updates_dir(&dir).join(INSTALLER_NAME).exists());
}

#[tokio::test]
async fn a_release_without_an_installer_fails_before_downloading_anything() {
    let (_gh, calls) =
        FakeGh::new(vec![Release::stable("v1.1.0").assets(&["notes.txt"])]).install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err.message.contains("missing an installer"));
    assert_eq!(calls_starting_with(&calls, &["release", "download"]), 0);
    assert_eq!(store.lock().await.get().phase, UpdatePhase::Failed);
}

#[tokio::test]
async fn a_release_without_a_checksum_fails_before_downloading_anything() {
    let (_gh, calls) =
        FakeGh::new(vec![Release::stable("v1.1.0").assets(&[INSTALLER_NAME])]).install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err.message.contains("missing its checksum asset"));
    assert_eq!(calls_starting_with(&calls, &["release", "download"]), 0);
}

#[tokio::test]
async fn an_ambiguous_release_with_two_installers_is_refused() {
    let (_gh, _) =
        FakeGh::new(vec![Release::stable("v1.1.0").assets(&["a.exe", "b.exe"])]).install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err.message.contains("expected exactly one"));
}

#[tokio::test]
async fn a_timed_out_download_fails_with_a_readable_message() {
    let (_gh, _) = FakeGh::new(release_with_installer())
        .download(Download::TimeOut)
        .install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert_eq!(err.message, "Download timed out.");
    assert_eq!(store.lock().await.get().phase, UpdatePhase::Failed);
}

#[tokio::test]
async fn a_gh_that_reports_success_but_wrote_nothing_is_a_failure() {
    let (_gh, _) = FakeGh::new(release_with_installer()).install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err
        .message
        .contains("missing its installer or checksum file"));
}

#[tokio::test]
async fn a_huge_gh_error_is_capped_before_it_is_stored_or_shown() {
    let (_gh, _) = FakeGh::new(release_with_installer())
        .download(Download::Fail("x".repeat(5_000)))
        .install();
    let (store, dir) = open_store(available).await;

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err.message.chars().count() <= MAX_ERROR_LEN + 3);
    let stored = store.lock().await.get().last_error.expect("last error");
    assert_eq!(stored, err.message);
}

#[tokio::test]
async fn a_retry_starts_from_a_clean_updates_directory() {
    let (_gh, _) = FakeGh::new(release_with_installer())
        .download(Download::Fail("network dropped".to_string()))
        .install();
    let (store, dir) = open_store(available).await;
    let leftover = updates_dir(&dir).join("Refract-old.exe");
    std::fs::create_dir_all(updates_dir(&dir)).expect("create updates dir");
    std::fs::write(&leftover, b"half a download").expect("write leftover");

    let err = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(err.message.contains("network dropped"));
    assert!(!leftover.exists(), "an earlier attempt's files are cleared");
}

#[tokio::test]
async fn a_failed_download_can_be_retried_after_the_next_check() {
    let (first, _) = FakeGh::new(release_with_installer())
        .download(Download::Fail("network dropped".to_string()))
        .install();
    let (store, dir) = open_store(available).await;
    download_update(&store, &dir, &no_op).await.unwrap_err();
    assert_eq!(store.lock().await.get().phase, UpdatePhase::Failed);
    // `Failed` is not `Available`, so downloading again needs a fresh check first.
    let refused = download_update(&store, &dir, &no_op).await.unwrap_err();
    assert_eq!(refused.code, UpdateErrorCode::UpdateUnavailable);
    drop(first);

    let (_second, _) = FakeGh::new(release_with_installer())
        .serving(b"bytes", &sha256_hex(b"other"))
        .install();
    crate::updates::checker::check_for_updates(&store, false, "1.0.0", &no_op).await;
    let retried = download_update(&store, &dir, &no_op).await.unwrap_err();

    assert!(
        retried.message.contains("published checksum"),
        "{}",
        retried.message
    );
    assert!(!retried.message.contains("network dropped"));
}

#[tokio::test]
async fn the_renderer_sees_downloading_then_the_failure() {
    let (_gh, _) = FakeGh::new(release_with_installer())
        .download(Download::Fail("boom".to_string()))
        .install();
    let (store, dir) = open_store(available).await;
    let seen = Mutex::new(Vec::new());

    download_update(&store, &dir, &|state: &UpdateState| {
        seen.lock().unwrap().push(state.phase)
    })
    .await
    .unwrap_err();

    assert_eq!(
        *seen.lock().unwrap(),
        vec![UpdatePhase::Downloading, UpdatePhase::Failed]
    );
}
