// Test module for `process.rs`, split into its own file via `#[path = ...]` (same convention
// `omp/redact.rs` -> `redact_tests.rs` and `git/worktrees.rs` -> `worktrees_tests.rs` already
// use) rather than adding to a file already well past the 600-line soft cap.

use super::*;

/// Security regression (gate round 4, 2026-10-14): seeking to an arbitrary byte offset used to
/// return whatever followed it verbatim, including a credential fragment split by the seek --
/// no pattern in `omp::redact` recognises a partial token, so it would have survived the
/// warn/error filter and redaction downstream unredacted.
#[tokio::test]
async fn read_tail_bytes_drops_a_mid_line_fragment_from_an_arbitrary_seek() {
    let dir = std::env::temp_dir().join(format!("refract-process-tests-{}", uuid::Uuid::new_v4()));
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
    let dir = std::env::temp_dir().join(format!("refract-process-tests-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("log.txt");
    tokio::fs::write(&path, b"short content, no seek needed")
        .await
        .unwrap();

    let result = read_tail_bytes(&path, 1000).await.expect("the file reads");
    assert_eq!(result, "short content, no seek needed");

    let _ = tokio::fs::remove_dir_all(&dir).await;
}
