use super::*;

fn scratch_file() -> PathBuf {
    crate::test_scratch::path(format!("working-modes-{}", uuid::Uuid::new_v4()))
        .join("working-modes.json")
}

#[tokio::test]
async fn a_session_with_no_file_has_no_stored_mode() {
    assert_eq!(load_from(&scratch_file(), "s1").await, None);
}

#[tokio::test]
async fn a_saved_mode_comes_back_for_that_session_only() {
    let path = scratch_file();
    save_to(&path, "s1", WorkingMode::Plan).await;
    save_to(&path, "s2", WorkingMode::Grill).await;

    assert_eq!(load_from(&path, "s1").await, Some(WorkingMode::Plan));
    assert_eq!(load_from(&path, "s2").await, Some(WorkingMode::Grill));
    assert_eq!(load_from(&path, "s3").await, None);
}

#[tokio::test]
async fn saving_again_replaces_the_mode_and_keeps_the_other_sessions() {
    let path = scratch_file();
    save_to(&path, "s1", WorkingMode::Plan).await;
    save_to(&path, "s2", WorkingMode::Grill).await;
    save_to(&path, "s1", WorkingMode::Interactive).await;

    assert_eq!(load_from(&path, "s1").await, Some(WorkingMode::Interactive));
    assert_eq!(load_from(&path, "s2").await, Some(WorkingMode::Grill));
}

#[tokio::test]
async fn away_is_stored_as_interactive_so_a_restart_drops_it() {
    let path = scratch_file();
    save_to(&path, "s1", WorkingMode::Away).await;

    assert_eq!(load_from(&path, "s1").await, Some(WorkingMode::Interactive));
    let raw = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(
        !raw.contains("away"),
        "Away must never reach the file: {raw}"
    );
}

#[tokio::test]
async fn a_corrupt_file_reads_as_no_stored_mode_and_is_set_aside() {
    let path = scratch_file();
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&path, b"{ not json").await.unwrap();

    assert_eq!(load_from(&path, "s1").await, None);
    assert!(
        !path.exists(),
        "the unreadable file is quarantined, not re-read every time"
    );
}

#[tokio::test]
async fn saving_over_a_corrupt_file_starts_a_fresh_one() {
    let path = scratch_file();
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&path, b"[1, 2").await.unwrap();

    save_to(&path, "s1", WorkingMode::Grill).await;

    assert_eq!(load_from(&path, "s1").await, Some(WorkingMode::Grill));
}

#[tokio::test]
async fn an_unknown_mode_in_the_file_reads_as_no_stored_mode() {
    let path = scratch_file();
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&path, br#"{"s1":"turbo"}"#).await.unwrap();

    assert_eq!(load_from(&path, "s1").await, None);
}
