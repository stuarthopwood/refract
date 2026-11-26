use super::*;

fn scratch_dir(label: &str) -> std::path::PathBuf {
    crate::test_scratch::path(format!("{label}-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn a_plan_launch_passes_the_overlay_as_a_config_file() {
    let dir = scratch_dir("plan-args-ok");
    tokio::fs::create_dir_all(&dir).await.unwrap();

    let args = plan_overlay_args(&dir).await.unwrap();

    assert_eq!(args[0], "--config");
    assert_eq!(
        args[1],
        super::super::plan_overlay::path(&dir).to_string_lossy()
    );
}

#[tokio::test]
async fn a_plan_launch_fails_when_the_overlay_cannot_be_written() {
    // A regular file where the data directory should be makes every write under it fail.
    let blocker = scratch_dir("plan-args-blocked");
    tokio::fs::create_dir_all(blocker.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&blocker, b"not a directory")
        .await
        .unwrap();

    let err = plan_overlay_args(&blocker.join("data"))
        .await
        .expect_err("a plan launch without its deny policy must not start");

    assert!(
        err.message.contains("not launching without it"),
        "{}",
        err.message
    );
}
