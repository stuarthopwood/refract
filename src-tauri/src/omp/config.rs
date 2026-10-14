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

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
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

impl OmpConfigErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OmpNotFound => "omp-not-found",
            Self::OmpFailed => "omp-failed",
            Self::Timeout => "timeout",
            Self::ParseFailed => "parse-failed",
            Self::InvalidValue => "invalid-value",
        }
    }
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

async fn ensure_scratch_dir() -> Result<PathBuf, OmpConfigError> {
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
// Raw `omp` invocation (mirrors `ompRaw`/`run`).
// ---------------------------------------------------------------------------

async fn run_omp(
    args: &[&str],
    failure_message: &str,
    env_override: Option<&HashMap<String, String>>,
    cwd: &std::path::Path,
) -> Result<String, OmpConfigError> {
    let omp_path =
        resolve_omp().map_err(|err| OmpConfigError::new(OmpConfigErrorCode::OmpNotFound, err))?;
    let mut command = Command::new(&omp_path);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW.0);
    if let Some(env) = env_override {
        command.env_clear().envs(env);
    }
    let child = command.spawn().map_err(|err| {
        OmpConfigError::new(
            OmpConfigErrorCode::OmpFailed,
            format!("Could not start omp: {err}"),
        )
    })?;
    let output =
        match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), child.wait_with_output())
            .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => {
                return Err(OmpConfigError::new(
                    OmpConfigErrorCode::OmpFailed,
                    format!("omp exited abnormally: {err}"),
                ))
            }
            Err(_) => {
                return Err(OmpConfigError::new(
                    OmpConfigErrorCode::Timeout,
                    "omp config timed out.",
                ))
            }
        };
    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr_text.trim();
        if !trimmed.is_empty() {
            log::warn!(
                "omp config call failed: {}",
                &trimmed[..trimmed.len().min(500)]
            );
        }
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::OmpFailed,
            failure_message,
        ));
    }
    if output.stdout.len() > MAX_STDOUT_BYTES {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned output exceeding the output size limit.",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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

// ---------------------------------------------------------------------------
// Generic `omp config get/set` (#691): any key, typed as a raw `Value`, serialised only at the
// caller's own read-merge-write transaction (see module header).
// ---------------------------------------------------------------------------

/// `omp config get <key> --json`: the full decoded `{key, value, type, description?}` object, so
/// a future caller can feature-detect by key (does `type`/`description` exist at all) as well as
/// read the effective value.
pub async fn get_config(
    key: &str,
    env_override: Option<&HashMap<String, String>>,
) -> Result<Value, OmpConfigError> {
    let cwd = ensure_scratch_dir().await?;
    let stdout = run_omp(
        &["config", "get", key, "--json"],
        "Could not read omp config.",
        env_override,
        &cwd,
    )
    .await?;
    parse_object_json(&stdout)
}

/// `omp config set <key> '<json>' --json`: always writes the GLOBAL `config.yml` (confirmed live,
/// FINDINGS item 48); returns the full decoded response object, including `overriddenBy` when a
/// higher-priority layer still supplies the effective value.
pub async fn set_config(
    key: &str,
    value: &Value,
    env_override: Option<&HashMap<String, String>>,
) -> Result<Value, OmpConfigError> {
    let cwd = ensure_scratch_dir().await?;
    let value_arg = serde_json::to_string(value).expect("Value is always JSON-serialisable");
    let stdout = run_omp(
        &["config", "set", key, &value_arg, "--json"],
        "Could not save omp config.",
        env_override,
        &cwd,
    )
    .await?;
    parse_object_json(&stdout)
}

/// Runs an arbitrary `omp` subcommand (not `config get/set` specifically -- `ipc::model_roles`'s
/// own `omp models --kind <kind> --json` is the one other caller) against the same scratch cwd
/// and returns the raw parsed JSON, accepting either a top-level array or object (unlike
/// `get_config`/`set_config`'s own `parse_object_json`, which rejects a non-object -- `omp
/// models` can return a bare array).
pub async fn run_json(args: &[&str], failure_message: &str) -> Result<Value, OmpConfigError> {
    let cwd = ensure_scratch_dir().await?;
    let stdout = run_omp(args, failure_message, None, &cwd).await?;
    serde_json::from_str(&stdout).map_err(|_| {
        OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp returned output that was not valid JSON.",
        )
    })
}
