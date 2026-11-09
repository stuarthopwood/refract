// Generic `omp config get/set` engine. Every call runs in a lazily created scratch cwd, because
// `omp` loads a project config from `<cwd>/.omp/` whenever that directory is non-empty.
//
// `omp` treats a `config set` value starting with `-` as a flag, and `--` is sticky for the rest
// of the line. The only live-confirmed-safe ordering is `config set <key> --json -- <value>`.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
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

static SCRATCH_DIR: AsyncMutex<Option<PathBuf>> = AsyncMutex::const_new(None);

/// Exported so a test can assert a removed scratch directory is recreated on the next call.
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

/// One `omp` invocation. `strip_env_vars` removes variable names from the inherited environment.
pub trait OmpExecutor: Send + Sync {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        failure_message: &'a str,
        strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>>;
}

pub struct RealOmpExecutor;

/// Serialises every `omp config get/set` call process-wide (`omp models` never touches config).
/// Concurrent `omp` on one scratch cwd was suspected, not confirmed, to return partial config.
static OMP_INVOCATION_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

/// The deadline starts once the lock is held: a call queued behind slow edits must not time out
/// before it has run at all.
async fn call_config_locked(
    executor: &dyn OmpExecutor,
    args: &[String],
    failure_message: &str,
    strip_env_vars: &[&str],
) -> Result<String, OmpConfigError> {
    let _permit = OMP_INVOCATION_LOCK.lock().await;
    match tokio::time::timeout(
        Duration::from_millis(TIMEOUT_MS),
        executor.call(args, failure_message, strip_env_vars),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(timeout_error()),
    }
}

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

/// Maps a spawn failure: a missing binary becomes `OmpNotFound`, anything else `OmpFailed`.
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

/// The one timeout error every caller sees.
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
        // A timed-out `omp` must not outlive the call: an orphaned process could still write late,
        // past the lock this guard holds.
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW.0);
    for var in strip_env_vars {
        command.env_remove(var);
    }
    let mut child = command.spawn().map_err(|err| map_spawn_error(&err))?;
    let stdout_pipe = child.stdout.take().expect("configured as piped above");
    let stderr_pipe = child.stderr.take().expect("configured as piped above");

    // Debug-logs each call. Only the first three args are logged, so a `config set` value is never logged.
    let logged_args = &args[..args.len().min(3)];
    let start = std::time::Instant::now();
    let timeout_result = tokio::time::timeout(
        Duration::from_millis(TIMEOUT_MS),
        read_capped_output(&mut child, stdout_pipe, stderr_pipe, MAX_STDOUT_BYTES),
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis();
    match timeout_result {
        Ok(Ok((status, stdout_buf, stderr_buf))) => {
            log::debug!(
                "omp: args={logged_args:?} cwd={} elapsed_ms={elapsed_ms} exit_code={:?} timed_out=false stdout_len={}",
                cwd.display(),
                status.code(),
                stdout_buf.len(),
            );
            map_run_result(status.success(), &stdout_buf, &stderr_buf, failure_message)
        }
        Ok(Err(err)) => {
            log::debug!(
                "omp: args={logged_args:?} cwd={} elapsed_ms={elapsed_ms} timed_out=false read_error={}",
                cwd.display(),
                err.message,
            );
            Err(err)
        }
        Err(_) => {
            log::debug!(
                "omp: args={logged_args:?} cwd={} elapsed_ms={elapsed_ms} timed_out=true",
                cwd.display(),
            );
            Err(timeout_error())
        }
    }
}

/// Reads `child`'s stdout (capped at `max_stdout_bytes`) and stderr concurrently. An oversize
/// stdout returns at once and kills the child, so the call never waits out the outer timeout.
async fn read_capped_output(
    child: &mut Child,
    stdout_pipe: ChildStdout,
    mut stderr_pipe: ChildStderr,
    max_stdout_bytes: usize,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>), OmpConfigError> {
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    // Bounded at the source, so a runaway `omp` cannot grow this process's memory past the cap.
    // Takes `stdout_pipe` by value so an early return drops the pipe handle.
    let mut limited_stdout = stdout_pipe.take(max_stdout_bytes as u64 + 1);
    let stdout_read = limited_stdout.read_to_end(&mut stdout_buf);
    let stderr_read = stderr_pipe.read_to_end(&mut stderr_buf);
    tokio::pin!(stdout_read);
    tokio::pin!(stderr_read);
    let mut stdout_done = false;
    let mut stderr_done = false;
    while !stdout_done || !stderr_done {
        tokio::select! {
            res = &mut stdout_read, if !stdout_done => {
                // Checks the count from `read_to_end`, not `stdout_buf.len()`, because the
                // pinned read future still borrows the buffer.
                let bytes_read = res.map_err(|err| {
                    OmpConfigError::new(
                        OmpConfigErrorCode::OmpFailed,
                        format!("Could not read omp output: {err}"),
                    )
                })?;
                stdout_done = true;
                if bytes_read as u64 > max_stdout_bytes as u64 {
                    let _ = child.start_kill();
                    return Err(OmpConfigError::new(
                        OmpConfigErrorCode::ParseFailed,
                        "omp returned output exceeding the output size limit.",
                    ));
                }
            }
            res = &mut stderr_read, if !stderr_done => {
                res.map_err(|err| {
                    OmpConfigError::new(
                        OmpConfigErrorCode::OmpFailed,
                        format!("Could not read omp output: {err}"),
                    )
                })?;
                stderr_done = true;
            }
        }
    }
    let status = child.wait().await.map_err(|err| {
        OmpConfigError::new(
            OmpConfigErrorCode::OmpFailed,
            format!("omp exited abnormally: {err}"),
        )
    })?;
    Ok((status, stdout_buf, stderr_buf))
}

/// Pure post-spawn decision, split out of `run_omp` for direct unit testing. A nonzero exit maps
/// to `OmpFailed` with the caller's own message, never raw stderr, which can echo local paths.
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
            // Logs only the stderr length, since a YAML error can echo a local path.
            log::debug!("omp call failed: stderr_len={}", trimmed.len());
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

/// Matches `^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$`, which rejects anything that could
/// read as a flag. Dotted segments are allowed for keys such as `advisor.reviewMode` (#1184).
fn validate_config_key(key: &str) -> Result<(), OmpConfigError> {
    let valid = !key.is_empty()
        && key.split('.').all(|segment| {
            let mut chars = segment.chars();
            chars
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric())
        });
    if !valid {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            "omp config key must be dot-separated identifiers (^[A-Za-z][A-Za-z0-9]*$ each).",
        ));
    }
    Ok(())
}

/// `omp config get <key> --json`. Returns the full `{key, value, type, description?}` object.
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
    let stdout = call_config_locked(
        executor,
        &args,
        "Could not read omp config.",
        strip_env_vars,
    )
    .await?;
    parse_object_json(&stdout)
}

pub async fn get_config(key: &str, strip_env_vars: &[&str]) -> Result<Value, OmpConfigError> {
    get_config_with(&RealOmpExecutor, key, strip_env_vars).await
}

/// `omp config list --json`: every effective setting as `{ "<key>": { value?, type, description } }`.
pub async fn list_config_with(
    executor: &dyn OmpExecutor,
    strip_env_vars: &[&str],
) -> Result<Value, OmpConfigError> {
    let args = vec![
        "config".to_string(),
        "list".to_string(),
        "--json".to_string(),
    ];
    let stdout = call_config_locked(
        executor,
        &args,
        "Could not read omp config.",
        strip_env_vars,
    )
    .await?;
    parse_object_json(&stdout)
}

pub async fn list_config(strip_env_vars: &[&str]) -> Result<Value, OmpConfigError> {
    list_config_with(&RealOmpExecutor, strip_env_vars).await
}

/// `omp config set <key> --json -- <json>`. Always writes the global `config.yml`.
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
    let stdout = call_config_locked(
        executor,
        &args,
        "Could not save omp config.",
        strip_env_vars,
    )
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

/// Runs an arbitrary `omp` subcommand and returns the parsed JSON. Accepts a top-level array,
/// which `omp models` can return.
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

// Tests live in a sibling file to stay under the 600-line cap.
#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
