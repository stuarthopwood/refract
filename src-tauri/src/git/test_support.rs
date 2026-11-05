// Real git repos, since a mocked git proves nothing about the safety properties under test.
// Scratch dirs live in a `test_scratch` TempDir that is removed when the test thread ends.

use std::path::{Path, PathBuf};

use tokio::process::Command;

/// Creates a fresh repository with one commit on `main`.
pub(crate) async fn init_repo() -> PathBuf {
    let dir = crate::test_scratch::path(format!("refract-git-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create temp repo dir");
    run_git(&dir, &["init", "--initial-branch=main", "-q"]).await;
    run_git(&dir, &["config", "user.email", "test@example.com"]).await;
    run_git(&dir, &["config", "user.name", "Test"]).await;
    tokio::fs::write(dir.join("README.md"), b"seed\n")
        .await
        .expect("write seed file");
    run_git(&dir, &["add", "."]).await;
    run_git(&dir, &["commit", "-q", "-m", "seed"]).await;
    dir
}

pub(crate) async fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .await
        .expect("spawn git");
    assert!(status.success(), "git {args:?} failed in {}", cwd.display());
}
