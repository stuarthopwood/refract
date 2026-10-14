// Test suite for `omp/config.rs`, split into this sibling file (via `#[path]`) only to keep
// `config.rs` itself comfortably under this build's 600-line-per-file cap -- same convention as
// `ipc/model_roles.rs`/`model_roles_tests.rs` and `store/settings.rs`/`settings_tests.rs`.
use super::*;

#[test]
fn validate_config_key_accepts_plain_identifiers_and_rejects_flags_and_dotted_keys() {
    assert!(validate_config_key("modelRoles").is_ok());
    assert!(validate_config_key("cycleOrder").is_ok());
    assert!(validate_config_key("-1").is_err());
    assert!(validate_config_key("--json").is_err());
    assert!(validate_config_key("composer.predictions").is_err());
    assert!(validate_config_key("").is_err());
}

#[test]
fn map_spawn_error_maps_not_found_to_omp_not_found_and_everything_else_to_omp_failed() {
    let not_found = io::Error::from(io::ErrorKind::NotFound);
    assert_eq!(
        map_spawn_error(&not_found).code,
        OmpConfigErrorCode::OmpNotFound
    );

    let permission_denied = io::Error::from(io::ErrorKind::PermissionDenied);
    assert_eq!(
        map_spawn_error(&permission_denied).code,
        OmpConfigErrorCode::OmpFailed
    );
}

#[test]
fn timeout_error_is_always_the_timeout_code() {
    assert_eq!(timeout_error().code, OmpConfigErrorCode::Timeout);
}

#[test]
fn map_run_result_maps_nonzero_exit_and_oversized_stdout() {
    let err = map_run_result(false, b"", b"boom", "custom failure message").unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::OmpFailed);
    assert_eq!(err.message, "custom failure message");

    let huge = vec![0u8; MAX_STDOUT_BYTES + 1];
    let err = map_run_result(true, &huge, b"", "unused").unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::ParseFailed);
}

#[test]
fn map_run_result_truncates_a_non_ascii_stderr_tail_by_character_not_byte() {
    // A byte-index cut at 500 could land inside a multi-byte character; this stderr is all
    // multi-byte so any byte-based slice would panic, while the char-based one never does.
    let stderr = "✗".repeat(600);
    let result = map_run_result(false, b"", stderr.as_bytes(), "msg");
    assert!(result.is_err());
}

#[tokio::test]
async fn ensure_scratch_dir_recreates_after_external_removal() {
    let first = ensure_scratch_dir().await.unwrap();
    assert!(tokio::fs::try_exists(&first).await.unwrap());
    tokio::fs::remove_dir(&first).await.unwrap();
    let second = ensure_scratch_dir().await.unwrap();
    assert!(tokio::fs::try_exists(&second).await.unwrap());
}

/// A minimal fake executor proving `get_config_with`/`set_config_with` build the exact argv
/// the module header documents, including the `--json -- <value>` ordering.
struct RecordingExecutor {
    calls: AsyncMutex<Vec<Vec<String>>>,
    response: String,
}

impl OmpExecutor for RecordingExecutor {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        _strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().await.push(args.to_vec());
            Ok(self.response.clone())
        })
    }
}

#[tokio::test]
async fn get_config_with_and_set_config_with_build_the_documented_argv() {
    let executor = RecordingExecutor {
        calls: AsyncMutex::new(Vec::new()),
        response: r#"{"key":"x","value":1}"#.to_string(),
    };
    get_config_with(&executor, "cycleOrder", &[]).await.unwrap();
    set_config_with(
        &executor,
        "cycleOrder",
        &Value::String("-1".to_string()),
        &[],
    )
    .await
    .unwrap();
    let calls = executor.calls.lock().await;
    assert_eq!(calls[0], vec!["config", "get", "cycleOrder", "--json"]);
    assert_eq!(
        calls[1],
        vec!["config", "set", "cycleOrder", "--json", "--", "\"-1\""]
    );
}

#[tokio::test]
async fn get_config_rejects_an_invalid_key_before_ever_calling_the_executor() {
    let executor = RecordingExecutor {
        calls: AsyncMutex::new(Vec::new()),
        response: String::new(),
    };
    let err = get_config_with(&executor, "--json", &[]).await.unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::InvalidValue);
    assert!(executor.calls.lock().await.is_empty());
}

/// Regression test for the pipe-drain hang (code review, round 4): a real child process whose
/// stdout exceeds a tiny cap must be killed and reported as `ParseFailed` promptly, never left
/// running until some outer timeout gives up. No real `omp` is needed (the bug is in the
/// generic pipe-draining code, not anything `omp`-specific): the child writes one line past the
/// cap, then spends ~29s pinging localhost before exiting on its own (`ping`, not a `for`/`while`
/// loop -- CI's Windows runner treats a compiled test binary that spawns a hidden-window `cmd.exe`
/// loop as a resource-exhaustion signature and silently corrupts the EXE on disk, reproduced
/// live as `STATUS_ENTRYPOINT_NOT_FOUND` on every CI run until this was found and changed; `ping`
/// as a deliberate delay is already an established pattern in this repo's own probe scripts,
/// FINDINGS item 11). The old buggy code always awaited `child.wait()` before ever checking the
/// byte count, so without the fix this test would block for the full ~29s delay and fail the 5s
/// test-local timeout; with the fix, the capped read resolves within milliseconds of the single
/// `echo`, `start_kill` fires immediately, and the child never reaches its natural ping-driven
/// exit.
#[tokio::test]
async fn read_capped_output_kills_the_child_and_returns_immediately_once_stdout_exceeds_the_cap() {
    let mut command = Command::new("cmd");
    command
        .args([
            "/C",
            "echo 0123456789abcdef0123456789abcdef & ping -n 30 127.0.0.1 >nul",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW.0);
    let mut child = command.spawn().expect("spawn cmd");
    let stdout_pipe = child.stdout.take().expect("configured as piped above");
    let stderr_pipe = child.stderr.take().expect("configured as piped above");

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        read_capped_output(&mut child, stdout_pipe, stderr_pipe, 16),
    )
    .await
    .expect("read_capped_output must return well within 5s, not hang through the ~29s ping delay");
    let err = result.unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::ParseFailed);

    // The child must actually have been killed, not left running to finish its own ~29s delay.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        child.try_wait().expect("try_wait").is_some(),
        "child should have been killed by read_capped_output, not left running"
    );
}
