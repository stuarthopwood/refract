// Test module for `worktree_holders.rs`, split into its own file via `#[path = ...]` (same
// pattern `worktree_delete.rs` uses for `worktree_delete_tests.rs`).

use super::*;

fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join(format!("refract-holders-{}", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn preflight_is_clear_for_a_missing_folder() {
    let missing = scratch_dir();
    preflight(&missing, &[]).await.expect("nothing to hold");
}

#[tokio::test]
async fn preflight_is_clear_for_an_untouched_folder() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    preflight(&dir, &[]).await.expect("an untouched folder is never held");
}

/// Restart Manager names THIS test process itself as a holder of a file it has open.
#[tokio::test]
async fn restart_manager_names_a_process_holding_a_file_open_inside_the_folder() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file_path = dir.join("held.txt");
    let _held = std::fs::File::create(&file_path).expect("open and hold a file open");

    let result = preflight(&dir, &[]).await;
    assert!(
        result.is_err(),
        "Restart Manager must name this test process itself as a holder of its own open file"
    );
    let err = result.unwrap_err();
    assert_eq!(err.code, GitErrorCode::WorktreeHeld);
}

/// Isolates the EXCLUSION rule itself (never the rename-probe's own independent behaviour,
/// which a still-open file handle can separately trip depending on its share mode): this
/// Session's own recorded pids must be dropped from Restart Manager's own raw findings, the
/// exact mechanism `sessions.delete`'s preflight relies on to never refuse on its own agent's
/// open files.
#[tokio::test]
async fn restart_manager_excludes_the_given_pid_from_its_own_findings() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file_path = dir.join("held.txt");
    let _held = std::fs::File::create(&file_path).expect("open and hold a file open");
    let own_pid = std::process::id();

    // Restart Manager's own scan is not always instantaneous right after a handle opens; retry
    // briefly rather than treat a slow first query as a real absence (the production preflight
    // itself never needs this -- a real Delete attempt is never racing its own `File::create`
    // by microseconds).
    let mut found = Vec::new();
    for _ in 0..20 {
        let path = dir.clone();
        found = tokio::task::spawn_blocking(move || imp::restart_manager_holders(&path, &[]))
            .await
            .unwrap();
        if found.iter().any(|h| h.pid == own_pid) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        found.iter().any(|h| h.pid == own_pid),
        "Restart Manager must find this test process holding its own open file"
    );

    let path = dir.clone();
    let excluded =
        tokio::task::spawn_blocking(move || imp::restart_manager_holders(&path, &[own_pid]))
            .await
            .unwrap();
    assert!(
        !excluded.iter().any(|h| h.pid == own_pid),
        "excluding the pid must drop it from the results"
    );
}

/// The rename-probe path: a process with its CURRENT DIRECTORY inside the folder holds no file
/// handle Restart Manager can see, but blocks the folder from being renamed. Killing it must let
/// a later Retry (a second `preflight` call) succeed. Spawns `ping.exe` DIRECTLY (not `cmd /C
/// ping`): killing a `cmd.exe` parent never kills the `ping.exe` grandchild it launched, which
/// would keep holding `dir` as its own inherited working directory indefinitely.
#[tokio::test]
async fn rename_probe_catches_a_process_whose_cwd_is_inside_the_folder() {
    let dir = scratch_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();

    let mut child = match tokio::process::Command::new("ping")
        .args(["-n", "60", "127.0.0.1"])
        .current_dir(&dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            eprintln!("skipping cwd-holder test: could not spawn ping.exe ({err})");
            return;
        }
    };
    // Give the child a moment to actually start and take `dir` as its current directory before
    // probing -- `spawn()` only guarantees the process object exists, not that Windows has
    // finished creating the process and establishing its working directory.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let result = preflight(&dir, &[]).await;
    assert!(
        result.is_err(),
        "a process with its cwd inside the folder must block the rename probe"
    );
    let err = result.unwrap_err();
    assert_eq!(err.code, GitErrorCode::WorktreeHeld);
    assert!(
        tokio::fs::metadata(&dir).await.is_ok(),
        "the folder must still be at its original path"
    );

    child.kill().await.ok();
    child.wait().await.ok();
    // The OS can take a moment to release the handle after the process exits.
    let mut cleared = false;
    for _ in 0..50 {
        if preflight(&dir, &[]).await.is_ok() {
            cleared = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(cleared, "Retry must succeed once the cwd-holding process is gone");
}
