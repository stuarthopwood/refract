// `GhLoginFlow` is a long-lived raw spawn, not a single timed call, so it is not built on `gh_raw`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex};

use super::gh::{gh_raw, GhError, GhErrorCode};

/// Windows-only: `CREATE_NO_WINDOW`.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `gh auth login --web` ignores stdin EOF while polling, so a long grace makes Cancel feel
/// broken. A pre-completion kill never touches the stored credential.
const CANCEL_GRACE_MS: u64 = 750;

/// Account commands are not repo-scoped, so `gh_raw` gets the OS temp dir as a neutral `cwd`.
fn account_cwd() -> PathBuf {
    std::env::temp_dir()
}

/// Runs `gh <args>` via `gh_raw` (15s timeout) and returns trimmed stdout.
// Error messages use stderr only, never stdout, which can be a secret (`auth token`).
async fn gh(args: &[&str]) -> Result<String, GhError> {
    let cwd = account_cwd();
    let result = gh_raw(
        &cwd,
        args,
        Some(GhErrorCode::GhNotFound),
        Duration::from_millis(super::gh::TIMEOUT_MS),
    )
    .await?;
    if result.timed_out {
        return Err(GhError::new(
            GhErrorCode::Timeout,
            format!(
                "gh {} did not respond within the timeout.",
                args.first().unwrap_or(&"")
            ),
        ));
    }
    if result.code != 0 {
        let detail = crate::omp::redact::redact_secrets(result.stderr.trim());
        return Err(GhError::new(
            GhErrorCode::GhFailed,
            format!(
                "gh {} failed: {}",
                args.join(" "),
                if detail.is_empty() {
                    "no output"
                } else {
                    &detail
                }
            ),
        ));
    }
    Ok(result.stdout.trim().to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhAccountProblem {
    Expired,
    Unreachable,
    Unknown,
}

impl GhAccountProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Unreachable => "unreachable",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GhAuthHostEntry {
    pub host: String,
    pub login: String,
    pub active: bool,
    pub state: String,
    /// Set when `state != "success"`; the raw `error` text must never reach the renderer or logs.
    pub problem: Option<GhAccountProblem>,
}

#[derive(Debug, Deserialize)]
struct GhAuthStatusHostAccount {
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    state: Option<String>,
    /// Raw failure detail; classified into `GhAccountProblem`, never stored or exposed.
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct GhAuthStatusJson {
    #[serde(default)]
    hosts: HashMap<String, Vec<GhAuthStatusHostAccount>>,
}

/// Classifies a non-success account's `error` text into a fixed `GhAccountProblem`; the raw text
/// is read only here.
fn classify_account_problem(state: &str, error: Option<&str>) -> Option<GhAccountProblem> {
    if state == "success" {
        return None;
    }
    if state == "timeout" {
        return Some(GhAccountProblem::Unreachable);
    }
    let text = error.unwrap_or("").to_lowercase();
    let token_index = text.find("token");
    let expired = text.contains("401")
        || text.contains("bad credentials")
        || token_index
            .map(|i| {
                let after = &text[i..];
                after.contains("invalid") || after.contains("expired") || after.contains("revoked")
            })
            .unwrap_or(false)
        || text.contains("reauthenticate")
        || text.contains("re-authenticate")
        || text.contains("authentication failed");
    if expired {
        return Some(GhAccountProblem::Expired);
    }
    let unreachable = text.contains("timeout")
        || text.contains("timed out")
        || text.contains("dial tcp")
        || text.contains("no such host")
        || text.contains("enotfound")
        || text.contains("econn")
        || text.contains("network")
        || text.contains("unreachable")
        || text.contains("offline")
        || text.contains("eai_again")
        || text.contains("tls")
        || text.contains("certificate");
    if unreachable {
        return Some(GhAccountProblem::Unreachable);
    }
    Some(GhAccountProblem::Unknown)
}

/// Runs `gh auth status --json hosts` and flattens every host's accounts into one list.
// A non-empty stdout is authoritative despite a non-zero exit; empty/non-JSON on failure is `gh-failed`.
pub async fn auth_status() -> Result<Vec<GhAuthHostEntry>, GhError> {
    let cwd = account_cwd();
    let result = gh_raw(
        &cwd,
        &["auth", "status", "--json", "hosts"],
        Some(GhErrorCode::GhNotFound),
        Duration::from_millis(super::gh::TIMEOUT_MS),
    )
    .await?;
    if result.timed_out {
        return Err(GhError::new(
            GhErrorCode::Timeout,
            "gh auth status did not respond within the timeout.",
        ));
    }
    let parsed: GhAuthStatusJson = if result.stdout.trim().is_empty() {
        if result.code != 0 {
            let detail = crate::omp::redact::redact_secrets(result.stderr.trim());
            return Err(GhError::new(
                GhErrorCode::GhFailed,
                format!(
                    "gh auth status --json hosts failed: {}",
                    if detail.is_empty() {
                        "no output"
                    } else {
                        &detail
                    }
                ),
            ));
        }
        GhAuthStatusJson::default()
    } else {
        serde_json::from_str(&result.stdout).map_err(|_| {
            let detail = crate::omp::redact::redact_secrets(result.stderr.trim());
            GhError::new(
                GhErrorCode::GhFailed,
                format!(
                    "gh auth status --json hosts returned unparseable output: {}",
                    if detail.is_empty() {
                        "gh produced no diagnostic output."
                    } else {
                        &detail
                    }
                ),
            )
        })?
    };
    Ok(flatten_auth_status(parsed))
}

/// Flattens the per-host account map, keeping `gh`'s (non-alphabetical) account order.
fn flatten_auth_status(parsed: GhAuthStatusJson) -> Vec<GhAuthHostEntry> {
    let mut entries = Vec::new();
    for (host_key, accounts) in parsed.hosts {
        for account in accounts {
            let state = account
                .state
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            entries.push(GhAuthHostEntry {
                host: account.host.unwrap_or(host_key.clone()),
                login: account.login.unwrap_or_default(),
                active: account.active == Some(true),
                problem: classify_account_problem(&state, account.error.as_deref()),
                state,
            });
        }
    }
    entries
}

/// Returns a (possibly non-active) account's token without a switch; callers must never persist it.
pub async fn auth_token(host: &str, login: &str) -> Result<String, GhError> {
    gh(&["auth", "token", "--hostname", host, "--user", login]).await
}

/// Runs `gh auth switch --hostname <host> --user <login>`.
pub async fn auth_switch(host: &str, login: &str) -> Result<(), GhError> {
    gh(&["auth", "switch", "--hostname", host, "--user", login]).await?;
    Ok(())
}

/// Runs `gh auth logout --hostname <host> --user <login>`.
pub async fn auth_logout(host: &str, login: &str) -> Result<(), GhError> {
    gh(&["auth", "logout", "--hostname", host, "--user", login]).await?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct GhLoginExitInfo {
    pub code: Option<i32>,
    pub requested: bool,
    /// Plain-language failure reason; never raw stderr, which can carry a command line or token.
    pub detail: Option<String>,
}

/// Events a `GhLoginFlow` emits: `Code` as soon as seen, `Exit` exactly once.
#[derive(Debug, Clone)]
pub enum GhLoginFlowEvent {
    Code(String),
    Exit(GhLoginExitInfo),
}

/// Last 2 KB of stderr, only to classify a failed exit; never logged or emitted.
const STDERR_TAIL_BYTES: usize = 2 * 1024;

struct FlowShared {
    stdout_buf: StdMutex<String>,
    stderr_tail: StdMutex<String>,
    requested: AtomicBool,
    exited: AtomicBool,
    exit_tx: watch::Sender<bool>,
    events_tx: mpsc::UnboundedSender<GhLoginFlowEvent>,
}

/// The one-time code is always `XXXX-XXXX`; anything else is a parsing fluke, not emitted.
fn is_valid_device_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    if bytes.len() != 9 || bytes[4] != b'-' {
        return false;
    }
    let is_upper_alnum = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit();
    bytes[..4].iter().all(|&b| is_upper_alnum(b)) && bytes[5..9].iter().all(|&b| is_upper_alnum(b))
}

impl FlowShared {
    fn handle_line(&self, line: &str) {
        if let Some(start) = line.find("One-time code (") {
            let after = &line[start + "One-time code (".len()..];
            if let Some(end) = after.find(')') {
                let code = &after[..end];
                if is_valid_device_code(code) {
                    let _ = self
                        .events_tx
                        .send(GhLoginFlowEvent::Code(code.to_string()));
                }
            }
        }
    }

    fn on_stream_data(&self, chunk: &[u8]) {
        let text = String::from_utf8_lossy(chunk);
        let mut buf = self.stdout_buf.lock().expect("stdout_buf mutex poisoned");
        buf.push_str(&text);
        while let Some(newline_index) = buf.find('\n') {
            let line = buf[..newline_index].trim().to_string();
            *buf = buf[newline_index + 1..].to_string();
            if !line.is_empty() {
                drop(buf);
                self.handle_line(&line);
                buf = self.stdout_buf.lock().expect("stdout_buf mutex poisoned");
            }
        }
    }

    fn on_stderr_tail_data(&self, chunk: &[u8]) {
        let text = String::from_utf8_lossy(chunk);
        let mut tail = self.stderr_tail.lock().expect("stderr_tail mutex poisoned");
        tail.push_str(&text);
        if tail.len() > STDERR_TAIL_BYTES {
            let mut start = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(start) {
                start += 1;
            }
            *tail = tail[start..].to_string();
        }
    }

    /// Classifies a failed login into a fixed sentence; raw stderr never leaves this method.
    fn classify_failure(&self) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .expect("stderr_tail mutex poisoned")
            .to_lowercase();
        if tail.contains("expired") {
            return "The code expired.".to_string();
        }
        if tail.contains("declined") || tail.contains("denied") || tail.contains("access_denied") {
            return "GitHub declined the sign-in.".to_string();
        }
        if tail.contains("network")
            || tail.contains("timeout")
            || tail.contains("dial")
            || tail.contains("enotfound")
        {
            return "Couldn't reach GitHub.".to_string();
        }
        "Sign-in did not finish.".to_string()
    }

    /// Guards against a double call (spawn-error path plus normal exit) emitting `Exit` twice.
    fn on_exit(&self, code: Option<i32>) {
        if self.exited.swap(true, Ordering::SeqCst) {
            return;
        }
        let remaining = {
            let mut buf = self.stdout_buf.lock().expect("stdout_buf mutex poisoned");
            let remaining = buf.trim().to_string();
            buf.clear();
            remaining
        };
        if !remaining.is_empty() {
            self.handle_line(&remaining);
        }
        let _ = self.exit_tx.send(true);
        let requested = self.requested.load(Ordering::SeqCst);
        let detail = if !requested && code != Some(0) {
            Some(self.classify_failure())
        } else {
            None
        };
        let _ = self.events_tx.send(GhLoginFlowEvent::Exit(GhLoginExitInfo {
            code,
            requested,
            detail,
        }));
    }
}

/// Drives one `gh auth login --web` child, streaming its output lines as `Code` events.
/// `cancel()` closes stdin, then `taskkill /T /F`s after a grace period.
pub struct GhLoginFlow {
    shared: Arc<FlowShared>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pid: Option<u32>,
    exit_rx: watch::Receiver<bool>,
    cancel_started: AsyncMutex<bool>,
}

impl GhLoginFlow {
    /// Spawns the child and returns the flow plus its event channel (resolves once spawned).
    pub async fn start(
        host: &str,
    ) -> Result<(Arc<GhLoginFlow>, mpsc::UnboundedReceiver<GhLoginFlowEvent>), GhError> {
        let gh_path = super::gh::resolve_gh().map_err(|_| {
            GhError::new(
                GhErrorCode::GhNotFound,
                "The GitHub CLI (gh) is not installed or not on PATH.",
            )
        })?;

        let mut command = tokio::process::Command::new(&gh_path);
        command
            .args(["auth", "login", "--hostname", host, "--web"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = command.spawn().map_err(|err| {
            let code = if err.kind() == std::io::ErrorKind::NotFound {
                GhErrorCode::GhNotFound
            } else {
                GhErrorCode::GhFailed
            };
            GhError::new(code, format!("gh auth login failed to spawn: {err}"))
        })?;

        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(false);
        let shared = Arc::new(FlowShared {
            stdout_buf: StdMutex::new(String::new()),
            stderr_tail: StdMutex::new(String::new()),
            requested: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_tx,
            events_tx,
        });

        if let Some(mut stdout) = stdout {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => shared.on_stream_data(&buf[..n]),
                    }
                }
            });
        }
        if let Some(mut stderr) = stderr {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            shared.on_stream_data(&buf[..n]);
                            shared.on_stderr_tail_data(&buf[..n]);
                        }
                    }
                }
            });
        }
        {
            let shared = shared.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                let code = status.ok().and_then(|s| s.code());
                shared.on_exit(code);
            });
        }

        Ok((
            Arc::new(GhLoginFlow {
                shared,
                stdin: AsyncMutex::new(stdin),
                pid,
                exit_rx,
                cancel_started: AsyncMutex::new(false),
            }),
            events_rx,
        ))
    }

    /// Idempotent: stdin close, then `taskkill` after `CANCEL_GRACE_MS`.
    pub async fn cancel(self: &Arc<Self>) {
        self.shared.requested.store(true, Ordering::SeqCst);
        let mut started = self.cancel_started.lock().await;
        if *started {
            return;
        }
        *started = true;
        self.do_cancel().await;
    }

    async fn do_cancel(self: &Arc<Self>) {
        if self.shared.exited.load(Ordering::SeqCst) {
            return;
        }
        if let Some(mut stdin) = self.stdin.lock().await.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.shutdown().await;
        }
        let exited = self.wait_for_exit(CANCEL_GRACE_MS).await;
        if !exited {
            self.hard_kill().await;
        }
    }

    async fn hard_kill(&self) {
        let Some(pid) = self.pid else { return };
        if self.shared.exited.load(Ordering::SeqCst) {
            return;
        }
        let taskkill = crate::process::executables::taskkill_path();
        let _ = tokio::process::Command::new(&taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        // taskkill /F is reliable; wait for the real exit rather than a second timeout.
        let mut rx = self.exit_rx.clone();
        let _ = rx.wait_for(|exited| *exited).await;
    }

    async fn wait_for_exit(&self, timeout_ms: u64) -> bool {
        if self.shared.exited.load(Ordering::SeqCst) {
            return true;
        }
        let mut rx = self.exit_rx.clone();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            rx.wait_for(|exited| *exited),
        )
        .await;
        result.is_ok()
    }
}

/// Starts a `gh auth login --web` flow; see `GhLoginFlow`.
pub async fn auth_login_start(
    host: &str,
) -> Result<(Arc<GhLoginFlow>, mpsc::UnboundedReceiver<GhLoginFlowEvent>), GhError> {
    GhLoginFlow::start(host).await
}

/// Cancels `flow`; alias for `GhLoginFlow::cancel()`.
pub async fn auth_login_cancel(flow: &Arc<GhLoginFlow>) {
    flow.cancel().await;
}

// Tests live in a sibling file to stay under the 600-line cap (#806).
#[cfg(test)]
#[path = "cli_tests.rs"]
mod cli_tests;
