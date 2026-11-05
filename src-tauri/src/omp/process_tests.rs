// Test module for `process.rs`, kept in its own file via `#[path]` to stay under the line cap.

use super::*;

/// Security regression: a mid-line seek must not return a credential fragment that redaction misses.
#[tokio::test]
async fn read_tail_bytes_drops_a_mid_line_fragment_from_an_arbitrary_seek() {
    let dir = crate::test_scratch::path(format!("refract-process-tests-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("log.txt");
    let token = format!("sk-{}", "a".repeat(40));
    let content = format!("{}{token}\nsafe trailing line", "x".repeat(50));
    tokio::fs::write(&path, content.as_bytes()).await.unwrap();

    // Chosen so the seek lands inside `token` itself, not before or after it.
    let result = read_tail_bytes(&path, 30).await.expect("the file reads");
    assert_eq!(result, "safe trailing line");
    assert!(!result.contains("sk-"));
    assert!(!result.contains("aaa"));

    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn read_tail_bytes_returns_everything_when_the_file_is_smaller_than_the_cap() {
    let dir = crate::test_scratch::path(format!("refract-process-tests-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("log.txt");
    tokio::fs::write(&path, b"short content, no seek needed")
        .await
        .unwrap();

    let result = read_tail_bytes(&path, 1000).await.expect("the file reads");
    assert_eq!(result, "short content, no seek needed");

    let _ = tokio::fs::remove_dir_all(&dir).await;
}
