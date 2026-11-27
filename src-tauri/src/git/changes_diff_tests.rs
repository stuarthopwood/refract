// Tests for `changes_diff.rs`: what the Changes panel shows for untracked files, against real temp repos.

use super::*;
use crate::git::test_support::init_repo;

async fn write_bytes(repo: &Path, relative: &str, bytes: &[u8]) {
    tokio::fs::write(repo.join(relative), bytes).await.unwrap();
}

#[tokio::test]
async fn an_untracked_text_file_renders_as_an_all_additions_hunk() {
    let repo = init_repo().await;
    write_bytes(&repo, "new.txt", b"one\ntwo\n").await;

    let (patch, reason) = diff_text(&repo, "new.txt", false, true).await.unwrap();

    assert_eq!(patch, "@@ -0,0 +1,2 @@\n+one\n+two\n");
    assert_eq!(reason, None);
}

#[tokio::test]
async fn crlf_is_normalised_and_a_missing_final_newline_is_flagged() {
    let repo = init_repo().await;
    write_bytes(&repo, "win.txt", b"a\r\nb").await;

    let (patch, _) = diff_text(&repo, "win.txt", false, true).await.unwrap();

    assert_eq!(
        patch,
        "@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n"
    );
}

#[tokio::test]
async fn an_empty_untracked_file_has_no_hunk_and_no_refusal() {
    let repo = init_repo().await;
    write_bytes(&repo, "empty.txt", b"").await;

    let result = diff_text(&repo, "empty.txt", false, true).await.unwrap();

    assert_eq!(result, (String::new(), None));
}

#[tokio::test]
async fn an_untracked_binary_file_shows_a_reason_not_garbage() {
    let repo = init_repo().await;
    write_bytes(&repo, "blob.dat", &[0x50, 0x00, 0xFF, 0x01, 0x00]).await;

    let (patch, reason) = diff_text(&repo, "blob.dat", false, true).await.unwrap();

    assert_eq!(patch, "");
    assert_eq!(reason, Some(REASON_BINARY));
}

#[tokio::test]
async fn an_untracked_file_over_one_mebibyte_is_refused_not_rendered() {
    let repo = init_repo().await;
    write_bytes(&repo, "huge.txt", &vec![b'a'; 1024 * 1024 + 1]).await;

    let (patch, reason) = diff_text(&repo, "huge.txt", false, true).await.unwrap();

    assert_eq!(patch, "");
    assert_eq!(reason, Some(REASON_TOO_LARGE));
}

#[tokio::test]
async fn a_stale_untracked_flag_on_a_tracked_file_still_gets_the_real_diff() {
    let repo = init_repo().await;
    write_bytes(&repo, "README.md", b"changed\n").await;

    let (patch, reason) = diff_text(&repo, "README.md", false, true).await.unwrap();

    assert_eq!(patch, "@@ -1 +1 @@\n-seed\n+changed\n");
    assert_eq!(reason, None);
}

#[tokio::test]
async fn an_ignored_file_is_never_read_even_when_flagged_untracked() {
    let repo = init_repo().await;
    write_bytes(&repo, ".gitignore", b"secret.txt\n").await;
    write_bytes(&repo, "secret.txt", b"token=abc\n").await;

    let (patch, reason) = diff_text(&repo, "secret.txt", false, true).await.unwrap();

    assert_eq!((patch.as_str(), reason), ("", None));
}

#[tokio::test]
async fn a_path_outside_the_worktree_is_refused() {
    let repo = init_repo().await;

    let err = diff_text(&repo, "../elsewhere.txt", false, true)
        .await
        .expect_err("outside path");

    assert_eq!(err.code, GitErrorCode::OutsideWorktree);
}
