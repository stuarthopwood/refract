// Shared test fixtures for `git::*`'s own test modules (lane R2, #785): a minimal real git
// repository, since every function this module ports shells out to a real `git` binary and a
// fake/mocked one would prove nothing about the actual safety properties under test (path
// containment, the #656 atomic-reservation race, the #599 safe-delete decision tree). Scratch
// directories are created under the OS temp dir and never removed, the same deliberate choice
// the Electron test suites these Rust tests port already make (see `terminationDetection.test.ts`
// /`registry.test.ts`'s own header comments) -- cleaning them up would need a destructive-delete
// guard this crate does not have yet, and leaving them behind is harmless.

use std::path::{Path, PathBuf};

use tokio::process::Command;

/// Creates a fresh repository with one commit on `main`, suitable as the `repo` argument for
/// every function in this module.
pub(crate) async fn init_repo() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refract-git-test-{}", uuid::Uuid::new_v4()));
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
