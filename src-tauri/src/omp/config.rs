// Generic `omp config get/set` (#691), part of Settings/theme/model roles/native menu (lane R8,
// issue #791). Port of `src/main/omp/config.ts`'s own generic engine: `get_config`/`set_config`
// run `omp config get/set <key> --json` for ANY key (a raw `serde_json::Value`, not a
// `modelRoles`-only wrapper), so the OMP feature batch (#692 to #695, #702, #704) can call this
// module directly for its own key when it lands, with no new CLI-spawning plumbing to write.
// `ipc::model_roles` (originally issue #455) is this engine's one caller today: it owns the
// model-roles-specific business logic (merge/validate/catalog parsing) `config.ts` keeps in this
// same file -- split out here only to stay under this build's 600-line-per-file cap.
//
// Every `omp` invocation runs with its cwd pointed at an unpredictable, empty-at-creation scratch
// directory created lazily (mirrors `ensureScratchDir`'s own TOCTOU-closing reasoning: `omp`
// loads a project config from `<cwd>/.omp/` whenever non-empty). Held behind one
// `tokio::sync::Mutex` across the whole check-then-create sequence -- unlike the TS module (which
// needed a second, explicit in-flight-promise memoisation on top of its cached path, since JS has
// no mutex), awaiting this lock across the whole sequence already serialises every concurrent
// caller with no extra bookkeeping. No `cleanupModelRolesScratchDir` equivalent is wired to any
// shutdown hook in this build (that hook lives in `lib.rs`, owned by lane R10b, #793): a
// directory left behind at quit is the same already-accepted, non-fatal case the TS module's own
// header documents.
//
// `get_config`/`set_config` take no lock of their own (same as `config.ts`'s own `run`/
// `ompRaw`): a caller with a real read-merge-write transaction (today, only `ipc::model_roles`'s
// `set_model_role`) holds its own lock across the whole sequence, mirroring `enqueueWrite`.
//
// `OmpExecutor` is the one seam a test can swap: `get_config_with`/`set_config_with`/
// `run_json_with` take `&dyn OmpExecutor` so a lane's own read-merge-write ordering (e.g.
// `ipc::model_roles`'s `set_model_role`) can be proven against a fake that records call order and
// simulates a slow write, without spawning a real `omp` process. `get_config`/`set_config`/
// `run_json` are the production callers, always using `RealOmpExecutor`.
//
// Quality-gate finding (code review, 2026-10-14): `omp`'s own CLI argument parser treats a
// `config set` value starting with `-` as an unknown flag (confirmed live, isolated profile:
// `config set k -1` -> "Unknown option '-1'"); `omp`'s own error message recommends `-- <value>`,
// but `--` is sticky for the REST of the command line (also confirmed live: `-- <value> --json`
// swallows `--json` into the value instead of parsing it as a flag, and `get -- <key> --json`
// degrades the response to `{}`). The only live-confirmed-safe ordering is flags first, then
// `--`, then the value last: `config set <key> --json -- <value>`.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::process::executables::resolve_omp;

const TIMEOUT_MS: u64 = 15_000;
const MAX_STDOUT_BYTES: usize = 1_048_576; // 1 MiB, matching `config.ts`'s own `maxBuffer`.
const SCRATCH_DIR_PREFIX: &str = "refract-omp-config-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OmpConfigErrorCode {
    OmpNotFound,
    OmpFailed,
    Timeout,
    ParseFailed,
    InvalidValue,
}

#[derive(Debug)]
pub struct OmpConfigError {
    pub code: OmpConfigErrorCode,
    pub message: String,
}

impl OmpConfigError {
    pub fn new(code: OmpConfigErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for OmpConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OmpConfigError {}

// ---------------------------------------------------------------------------
// Scratch directory (mirrors `ensureScratchDir`).
// ---------------------------------------------------------------------------

static SCRATCH_DIR: AsyncMutex<Option<PathBuf>> = AsyncMutex::const_new(None);

/// Exported (not only `pub(super)`) so a test can assert a removed scratch directory is
/// transparently recreated on the next call, the same retry guarantee `ensureScratchDir` gives.
pub async fn ensure_scratch_dir() -> Result<PathBuf, OmpConfigError> {
    let mut guard = SCRATCH_DIR.lock().await;
    if let Some(dir) = guard.as_ref() {
        if tokio::fs::try_exists(dir).await.unwrap_or(false) {
            return Ok(dir.clone());
        }
    }
    let base = std::env::temp_dir();
    for _ in 0..8 {
        let candidate = base.join(format!("{SCRATCH_DIR_PREFIX}{}", uuid::Uuid::new_v4()));
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => {
                *guard = Some(candidate.clone());
                return Ok(candidate);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    Err(OmpConfigError::new(
        OmpConfigErrorCode::OmpFailed,
        "Could not prepare a working directory for omp.",
    ))
}

// ---------------------------------------------------------------------------
// Raw `omp` invocation (mirrors `ompRaw`/`run`) and the injectable executor seam.
// ---------------------------------------------------------------------------

/// One `omp` invocation: `args` (every argument after the binary path), a caller-facing
/// `failure_message` for a non-zero exit, and `strip_env_vars` (variable NAMES removed from the
/// inherited environment before spawning -- never a replacement map, so every other inherited
/// variable, Unicode or not, survives untouched).
pub trait OmpExecutor: Send + Sync {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        failure_message: &'a str,
        strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>>;
}

pub struct RealOmpExecutor;

impl OmpExecutor for RealOmpExecutor {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        failure_message: &'a str,
        strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
        Box::pin(async move {
            let cwd = ensure_scratch_dir().await?;
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_omp(&arg_refs, failure_message, strip_env_vars, &cwd).await
        })
    }
}

/// Pure mapping for a `Command::spawn` failure: an `io::ErrorKind::NotFound` (the resolved path
/// stopped existing between `resolve_omp` and this call -- rare, but a real possible race) is
/// `OmpNotFound`, the same code a `which` resolution failure already produces; anything else is
/// the generic `OmpFailed`. Exported for direct unit testing (no real process needed).
fn map_spawn_error(err: &io::Error) -> OmpConfigError {
    if err.kind() == io::ErrorKind::NotFound {
        OmpConfigError::new(
            OmpConfigErrorCode::OmpNotFound,
            format!("omp is not installed or not on PATH: {err}"),
        )
    } else {
        OmpConfigError::new(
            OmpConfigErrorCode::OmpFailed,
            format!("Could not start omp: {err}"),
        )
    }
}

/// Pure constructor for the one timeout error every caller sees, split out alongside
/// `map_spawn_error` for the same direct-unit-testing reason (no real process needed).
fn timeout_error() -> OmpConfigError {
    OmpConfigError::new(OmpConfigErrorCode::Timeout, "omp config timed out.")
}

async fn run_omp(
    args: &[&str],
    failure_message: &str,
    strip_env_vars: &[&str],
    cwd: &Path,
) -> Result<String, OmpConfigError> {
    let omp_path =
        resolve_omp().map_err(|err| OmpConfigError::new(OmpConfigErrorCode::OmpNotFound, err))?;
    let mut command = Command::new(&omp_path);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A timed-out `omp` must not keep running past this call: the `MODEL_ROLES_WRITE_LOCK`
        // guard is released the instant this future is dropped (the `tokio::time::timeout` below
        // drops it on expiry), and an orphaned process could still land a late write afterwards
        // -- exactly the lost update the lock exists to prevent.
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW.0);
    for var in strip_env_vars {
        command.env_remove(var);
    }
    let mut child = command.spawn().map_err(|err| map_spawn_error(&err))?;
    let mut stdout_pipe = child.stdout.take().expect("configured as piped above");
    let mut stderr_pipe = child.stderr.take().expect("configured as piped above");

    let run = async {
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        // Bounded at the source (never buffers more than the cap, unlike reading everything
        // first and checking afterwards): `take` stops yielding bytes past the limit, so a
        // runaway `omp` can write gigabytes into its own stdout pipe without this process ever
        // holding more than `MAX_STDOUT_BYTES + 1` bytes in memory for it.
        let mut limited_stdout = (&mut stdout_pipe).take(MAX_STDOUT_BYTES as u64 + 1);
        let stdout_read = limited_stdout.read_to_end(&mut stdout_buf);
        let stderr_read = stderr_pipe.read_to_end(&mut stderr_buf);
        let (stdout_result, stderr_result) = tokio::join!(stdout_read, stderr_read);
        stdout_result.map_err(|err| {
            OmpConfigError::new(
                OmpConfigErrorCode::OmpFailed,
                format!("Could not read omp output: {err}"),
            )
        })?;
        stderr_result.map_err(|err| {
            OmpConfigError::new(
                OmpConfigErrorCode::OmpFailed,
                format!("Could not read omp output: {err}"),
            )
        })?;
        let status = child.wait().await.map_err(|err| {
            OmpConfigError::new(
                OmpConfigErrorCode::OmpFailed,
                format!("omp exited abnormally: {err}"),
            )
        })?;
        Ok::<_, OmpConfigError>((status, stdout_buf, stderr_buf))
    };

    let (status, stdout_buf, stderr_buf) =
        match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), run).await {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(timeout_error()),
        };
    map_run_result(status.success(), &stdout_buf, &stderr_buf, failure_message)
}

/// Pure post-spawn decision, split out of `run_omp` for direct unit testing (no real process
/// needed): nonzero exit -> `OmpFailed` (with the caller's own `failure_message`, never the raw
/// stderr -- a YAML parse error can echo a local path); a logged stderr tail is trimmed by
/// Unicode scalar, not byte index (a byte cut can land inside a multi-byte character and panic).
fn map_run_result(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    failure_message: &str,
) -> Result<String, OmpConfigError> {
    if !success {
        let stderr_text = String::from_utf8_lossy(stderr);
        let trimmed = stderr_text.trim();
        if !trimmed.is_empty() {
            let logged: String = trimmed.chars().take(500).collect();
            log::warn!("omp config call failed: {logged}");
        }
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::OmpFailed,
            failure_message,
        ));
    }
    if stdout.len() > MAX_STDOUT_BYTES {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned output exceeding the output size limit.",
        ));
    }
    Ok(String::from_utf8_lossy(stdout).into_owned())
}

fn parse_object_json(stdout: &str) -> Result<Value, OmpConfigError> {
    let value: Value = serde_json::from_str(stdout).map_err(|_| {
        OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned output that was not valid JSON.",
        )
    })?;
    if !value.is_object() {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned a JSON value that was not an object.",
        ));
    }
    Ok(value)
}

/// `^[A-Za-z][A-Za-z0-9]*$` (`omp config`'s own dotted-key rejection means a key never contains
/// `.` either): rejects anything that could reach `omp`'s argv looking like a flag (a key is
/// always a fixed, short identifier -- `modelRoles`, `composer.predictions`-style dotted keys are
/// already rejected by `omp` itself as "Unknown setting", confirmed live).
fn validate_config_key(key: &str) -> Result<(), OmpConfigError> {
    let mut chars = key.chars();
    let valid = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            "omp config key must match ^[A-Za-z][A-Za-z0-9]*$.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Generic `omp config get/set` (#691): any key, typed as a raw `Value`.
// ---------------------------------------------------------------------------

/// `omp config get <key> --json`: the full decoded `{key, value, type, description?}` object, so
/// a future caller can feature-detect by key (does `type`/`description` exist at all) as well as
/// read the effective value.
pub async fn get_config_with(
    executor: &dyn OmpExecutor,
    key: &str,
    strip_env_vars: &[&str],
) -> Result<Value, OmpConfigError> {
    validate_config_key(key)?;
    let args = vec![
        "config".to_string(),
        "get".to_string(),
        key.to_string(),
        "--json".to_string(),
    ];
    let stdout = executor
        .call(&args, "Could not read omp config.", strip_env_vars)
        .await?;
    parse_object_json(&stdout)
}

pub async fn get_config(key: &str, strip_env_vars: &[&str]) -> Result<Value, OmpConfigError> {
    get_config_with(&RealOmpExecutor, key, strip_env_vars).await
}

/// `omp config set <key> --json -- <json>`: always writes the GLOBAL `config.yml` (confirmed
/// live, FINDINGS item 48); returns the full decoded response object, including `overriddenBy`
/// when a higher-priority layer still supplies the effective value. The `--json -- <value>`
/// ordering (flags before `--`, the value last) is the one live-confirmed-safe shape: `--` is
/// sticky for the rest of the command line, so a flag placed after it is swallowed into the
/// value instead of being parsed (see module header).
pub async fn set_config_with(
    executor: &dyn OmpExecutor,
    key: &str,
    value: &Value,
    strip_env_vars: &[&str],
) -> Result<Value, OmpConfigError> {
    validate_config_key(key)?;
    let value_arg = serde_json::to_string(value).expect("Value is always JSON-serialisable");
    let args = vec![
        "config".to_string(),
        "set".to_string(),
        key.to_string(),
        "--json".to_string(),
        "--".to_string(),
        value_arg,
    ];
    let stdout = executor
        .call(&args, "Could not save omp config.", strip_env_vars)
        .await?;
    parse_object_json(&stdout)
}

pub async fn set_config(
    key: &str,
    value: &Value,
    strip_env_vars: &[&str],
) -> Result<Value, OmpConfigError> {
    set_config_with(&RealOmpExecutor, key, value, strip_env_vars).await
}

/// Runs an arbitrary `omp` subcommand (not `config get/set` specifically -- `ipc::model_roles`'s
/// own `omp models --kind <kind> --json` is the one other caller) and returns the raw parsed
/// JSON, accepting either a top-level array or object (unlike `get_config`/`set_config`'s own
/// `parse_object_json`, which rejects a non-object -- `omp models` can return a bare array).
pub async fn run_json_with(
    executor: &dyn OmpExecutor,
    args: &[&str],
    failure_message: &str,
) -> Result<Value, OmpConfigError> {
    let owned_args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let stdout = executor.call(&owned_args, failure_message, &[]).await?;
    serde_json::from_str(&stdout).map_err(|_| {
        OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned output that was not valid JSON.",
        )
    })
}

pub async fn run_json(args: &[&str], failure_message: &str) -> Result<Value, OmpConfigError> {
    run_json_with(&RealOmpExecutor, args, failure_message).await
}

#[cfg(test)]
mod tests {
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
}
