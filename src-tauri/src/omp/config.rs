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
// `get_config`/`set_config` serialise against every OTHER `config get/set` call via
// `call_config_locked`/`OMP_INVOCATION_LOCK` (below), but take no READ-MERGE-WRITE transaction
// lock of their own (same as `config.ts`'s own `run`/`ompRaw`): a caller with a real
// read-merge-write transaction (today, only `ipc::model_roles`'s `set_model_role`) holds its
// own separate lock across the whole sequence, mirroring `enqueueWrite`.
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

/// Serialises every real `omp config get/set` invocation process-wide, one at a time --
/// `omp models --kind` (`run_json_with`, Settings' own catalog reads) does NOT go through this:
/// it never touches config and would otherwise queue behind config reads/writes for no reason.
/// Concurrent invocations (lane RM's own `apply_role_change` sweep could run several
/// `apply_role_now` calls at once, each able to read `modelRoles`) all share the ONE memoised
/// scratch `cwd` above; under heavy load, concurrent `omp` processes racing in that same
/// directory were SUSPECTED (not confirmed -- a direct 65-call falsification against 3
/// concurrently-starting/-running `omp --mode rpc-ui` agents on the same profile reproduced
/// nothing) to intermittently return a response missing its own `value` field, or an empty
/// `modelRoles` record even when one is genuinely configured. Config reads are rare (never a
/// hot per-frame path), so correctness wins over any parallelism here.
static OMP_INVOCATION_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

/// Wraps the lock acquisition AND the `omp` call itself in ONE `TIMEOUT_MS` deadline, so a
/// caller queued behind others fails closed at that deadline total instead of eventually
/// acquiring the lock and then getting a FRESH budget on top (which would let queued callers
/// pile up for up to 2x the deadline under contention). Used by `get_config_with`/
/// `set_config_with` only -- see `OMP_INVOCATION_LOCK`'s own doc comment above for why
/// `run_json_with` does not call this.
async fn call_config_locked(
    executor: &dyn OmpExecutor,
    args: &[String],
    failure_message: &str,
    strip_env_vars: &[&str],
) -> Result<String, OmpConfigError> {
    match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), async {
        let _permit = OMP_INVOCATION_LOCK.lock().await;
        executor.call(args, failure_message, strip_env_vars).await
    })
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
    let stdout_pipe = child.stdout.take().expect("configured as piped above");
    let stderr_pipe = child.stderr.take().expect("configured as piped above");

    // Gate-fix (round 6, diagnostic): log every invocation at debug level -- args (truncated to
    // the first 3: the subcommand, `get`/`set`, and the key -- a `config set`'s own VALUE, past
    // index 2, is NEVER logged, security gate-fix), cwd, elapsed ms, exit code, whether it timed
    // out, and the stdout byte length, to confirm or rule out a concurrent-`omp`-process race
    // in the shared scratch `cwd` before changing behaviour based on a guess.
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

/// Reads `child`'s stdout (capped at `max_stdout_bytes`) and stderr concurrently. Gate-fix (code
/// review): the previous version read stdout through a `Take` adapter but never drained the
/// underlying pipe past the cap, so a runaway `omp` that kept writing past the limit would block
/// on the now-full OS pipe buffer and never reach EOF/exit on its own -- the 15 s outer timeout
/// then fired and reported `Timeout` (holding `MODEL_ROLES_WRITE_LOCK` for the full 15 s) instead
/// of the real "output too large" failure. Fixed: the instant the capped stdout read completes
/// and has exceeded `max_stdout_bytes`, this returns immediately -- the (now out-of-scope) `Take`
/// wrapper drops the owned `ChildStdout` with it, closing that end of the pipe, `child` is killed
/// via `start_kill` (no need to await it; `run_omp`'s own `kill_on_drop(true)` is the
/// belt-and-braces second guard), and stderr/`child.wait()` are never waited on -- matching
/// Electron's own `maxBuffer` behaviour (killed, not drained to completion). `max_stdout_bytes` is
/// a parameter (not `MAX_STDOUT_BYTES` directly) so a test can exercise this with a tiny cap and
/// a cheap child process, no real `omp` needed.
async fn read_capped_output(
    child: &mut Child,
    stdout_pipe: ChildStdout,
    mut stderr_pipe: ChildStderr,
    max_stdout_bytes: usize,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>), OmpConfigError> {
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    // Bounded at the source (never buffers more than the cap, unlike reading everything first
    // and checking afterwards): `take` stops yielding bytes past the limit, so a runaway `omp`
    // can write gigabytes into its own stdout pipe without this process ever holding more than
    // `max_stdout_bytes + 1` bytes in memory for it. Takes `stdout_pipe` BY VALUE (never a
    // `&mut` borrow of a separate variable) so an early return below can drop it -- and with it
    // the OS pipe handle -- without fighting the borrow checker over a still-live reference.
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
                // Checked on the byte count `read_to_end` itself returns, never on
                // `stdout_buf.len()`: the pinned `stdout_read` future borrows `stdout_buf` for
                // its own whole lifetime (it is polled again on later loop iterations whenever
                // `stderr_read` resolves first), so reading `stdout_buf` here while that borrow
                // is still in scope does not borrow-check.
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
            // Gate-fix (round 11, LOW, security): only the LENGTH is logged now, at debug --
            // not even a first line, since a YAML parse error can echo a local path (this
            // file's own header notes) directly in that first line too.
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

/// `^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$`: rejects anything that could reach `omp`'s
/// argv looking like a flag. Dotted segments are allowed since #1184: `omp config get/set`
/// accepts real dotted setting keys such as `advisor.reviewMode` (confirmed live); a dotted path
/// into a record (`modelRoles.advisor`) is still rejected by `omp` itself as "Unknown setting".
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

// Split into a sibling file (not inline here) only to keep this file comfortably under this
// build's 600-line-per-file cap -- same convention as `ipc/model_roles.rs`/
// `model_roles_tests.rs` and `store/settings.rs`/`settings_tests.rs`.
#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
