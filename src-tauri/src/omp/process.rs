// Drives one `omp --mode rpc-ui` child: spawn, JSONL framing, `rpc_chunk` reassembly, request
// correlation, ready-wait and stop. Non-response frames go to subscribers as raw `Value`.

mod latency;
pub use latency::RpcSample;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
// `std::sync::Mutex` for `pending`/`chunks`/`stderr_tail`: no critical section can panic.
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex as TokioMutex};
use tokio::time::Instant;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::process::executables;

// READY_PROMPT_AFTER_MS is when a caller may offer "Keep waiting"; the wait continues to
// READY_CEILING_MS, then fails (#512).
const READY_PROMPT_AFTER_MS: u64 = 60_000;
const READY_CEILING_MS: u64 = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const STOP_GRACE_MS: u64 = 10_000;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
const STDERR_FAILURE_TAIL_BYTES: usize = 2 * 1024;
const OMP_LOG_READ_WINDOW_BYTES: u64 = 64 * 1024;
const OMP_LOG_TAIL_BYTES: usize = 4 * 1024;
// A reassembled rpc_chunk sequence above this is corrupt, not buffered. Also caps an
// unterminated stdout line so the buffer cannot grow forever.
const MAX_REASSEMBLED_BYTES: u64 = 64 * 1024 * 1024;

/// Settings.approvalMode; serialises with the same string values as `OMP_APPROVAL_MODE`'s keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    AskAndRemember,
    EditFreely,
    Auto,
}

impl ApprovalMode {
    /// Maps to the value OMP's `--approval-mode` flag expects.
    pub(super) fn omp_flag(self) -> &'static str {
        match self {
            ApprovalMode::Ask => "always-ask",
            ApprovalMode::AskAndRemember => "always-ask-cached",
            ApprovalMode::EditFreely => "write",
            ApprovalMode::Auto => "yolo",
        }
    }
}

/// Options for spawning one `omp` process.
pub struct OmpProcessOptions {
    pub cwd: PathBuf,
    pub approval_mode: ApprovalMode,
    pub omp_path: Option<PathBuf>,
    /// Appends `--no-session`, so omp does not persist the session (#362).
    pub no_session: bool,
    /// Forces `plan.defaultOnStartup` for this process; `None` keeps the shared overlay (#433).
    pub plan_mode: Option<bool>,
    /// An extra `--config` overlay for this launch (omp accepts the flag repeatedly).
    pub extra_config: Option<PathBuf>,
    pub ready_prompt_after_ms: u64,
    pub ready_ceiling_ms: u64,
}

impl OmpProcessOptions {
    pub fn new(cwd: PathBuf, approval_mode: ApprovalMode) -> Self {
        Self {
            cwd,
            approval_mode,
            omp_path: None,
            no_session: false,
            plan_mode: None,
            extra_config: None,
            ready_prompt_after_ms: READY_PROMPT_AFTER_MS,
            ready_ceiling_ms: READY_CEILING_MS,
        }
    }
}

/// A plain message plus a flag marking the ready-wait ceiling, so callers need not match text.
#[derive(Debug, Clone)]
pub struct ProcessError {
    pub message: String,
    pub ready_ceiling: bool,
}

impl ProcessError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            ready_ceiling: false,
        }
    }
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProcessError {}

/// Staged ready-wait progress; the ceiling is reported as a `ProcessError` (`ready_ceiling`) (#512).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyWaitStage {
    Waiting,
    Prompt,
}

/// Payload of the process exit event.
#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub requested: bool,
}

/// Everything a subscriber can observe, except `request()` responses (consumed internally).
#[derive(Debug, Clone)]
pub enum ProcessEvent {
    /// Every decoded frame except `response` and `rpc_chunk` (reassembled, then re-dispatched).
    Frame(Value),
    /// Start-progress update.
    StartProgress {
        stage: ReadyWaitStage,
        elapsed_ms: u64,
    },
    /// Fires exactly once.
    Exit { code: Option<i32>, requested: bool },
}

struct ChunkAssembly {
    parts: Vec<Option<Vec<u8>>>,
    got: usize,
    byte_length: u64,
}

#[derive(Default)]
struct StderrTail {
    buf: Vec<u8>,
    truncated: bool,
}

struct Inner {
    pid: AtomicU64,
    requested_stop: AtomicBool,
    exited: AtomicBool,
    request_counter: AtomicU64,
    latency: latency::RpcLatency,
    pending: StdMutex<HashMap<String, oneshot::Sender<Result<Value, ProcessError>>>>,
    chunks: StdMutex<HashMap<String, ChunkAssembly>>,
    stderr_tail: StdMutex<StderrTail>,
    stdin: TokioMutex<Option<tokio::process::ChildStdin>>,
    /// Every live `subscribe()` consumer's sender. Unbounded `mpsc` per consumer: a broadcast ring
    /// buffer could drop a `session_settled`/`extension_ui_request` frame under a burst.
    events_subs: StdMutex<Vec<mpsc::UnboundedSender<ProcessEvent>>>,
    /// Set by `dispatch_frame` when "ready" is seen, BEFORE the broadcast: `wait_ready` subscribes
    /// after the reader starts, so it re-checks this instead of sitting out the ceiling (#512).
    ready_frame: StdMutex<Option<Value>>,
    exit_tx: watch::Sender<Option<ExitInfo>>,
    stop_cell: tokio::sync::OnceCell<()>,
    /// Set once at construction, read by `wait_ready`.
    spawned_at: Instant,
    spawned_at_system: SystemTime,
}

/// Fans `event` out to every live subscriber, pruning dropped receivers.
fn broadcast_event(inner: &Inner, event: ProcessEvent) {
    let mut subs = inner.events_subs.lock().unwrap();
    subs.retain(|tx| tx.send(event.clone()).is_ok());
}

impl Inner {
    /// Idempotent: a second call is a silent no-op.
    fn on_exit(&self, code: Option<i32>) {
        if self.exited.swap(true, Ordering::SeqCst) {
            return;
        }
        let requested = self.requested_stop.load(Ordering::SeqCst);
        let info = ExitInfo { code, requested };
        let _ = self.exit_tx.send(Some(info));
        broadcast_event(self, ProcessEvent::Exit { code, requested });
        // Nothing will answer an in-flight request now; fail them rather than await timeouts.
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(ProcessError::new(format!(
                "OmpProcess: process exited (code {code:?})"
            ))));
        }
    }
}

/// One running (or ready-waiting) `omp --mode rpc-ui` child process.
pub struct OmpProcess {
    inner: Arc<Inner>,
}

impl OmpProcess {
    /// Spawns `omp` and starts its reader tasks, returning before the ready handshake. Callers
    /// needing every frame must `subscribe()` first, then `wait_ready`.
    pub async fn connect(opts: &OmpProcessOptions) -> Result<Self, ProcessError> {
        Self::connect_with_warnings(opts, &mut Vec::new()).await
    }

    /// `connect`, also collecting this launch's token guard warnings for the caller to emit.
    pub async fn connect_with_warnings(
        opts: &OmpProcessOptions,
        warnings: &mut Vec<String>,
    ) -> Result<Self, ProcessError> {
        executables::ensure_no_default_cwd_in_exe_path();
        let omp_path = match &opts.omp_path {
            Some(path) => path.clone(),
            None => executables::resolve_omp().map_err(ProcessError::new)?,
        };
        let (args, launch_warnings) = super::process_args::build_args(opts).await;
        warnings.extend(launch_warnings);

        let mut command = Command::new(&omp_path);
        command.args(&args).current_dir(&opts.cwd);
        super::process_args::trust_system_ca(&mut command);
        Self::from_command(command)
    }

    /// Spawns a prepared `command` with piped stdio and starts the reader tasks. Split from
    /// `connect_with_warnings` so tests can drive a stub child without the launch arguments.
    pub(crate) fn from_command(mut command: Command) -> Result<Self, ProcessError> {
        command
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let spawned_at = Instant::now();
        let spawned_at_system = SystemTime::now();
        let mut child = command.spawn().map_err(|err| {
            let hint = if err.kind() == std::io::ErrorKind::NotFound {
                " (omp not found on PATH; set omp_path)"
            } else {
                ""
            };
            ProcessError::new(format!("OmpProcess: process failed to spawn: {err}{hint}"))
        })?;

        let pid = child.id().unwrap_or(0);
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(ProcessError::new("OmpProcess: stdio not piped"));
        };

        let (exit_tx, _exit_rx) = watch::channel(None);

        let inner = Arc::new(Inner {
            pid: AtomicU64::new(pid as u64),
            requested_stop: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            request_counter: AtomicU64::new(0),
            latency: latency::RpcLatency::default(),
            pending: StdMutex::new(HashMap::new()),
            chunks: StdMutex::new(HashMap::new()),
            stderr_tail: StdMutex::new(StderrTail::default()),
            stdin: TokioMutex::new(Some(stdin)),
            events_subs: StdMutex::new(Vec::new()),
            ready_frame: StdMutex::new(None),
            exit_tx,
            stop_cell: tokio::sync::OnceCell::new(),
            spawned_at,
            spawned_at_system,
        });

        tokio::spawn(stdout_reader_task(stdout, inner.clone()));
        tokio::spawn(stderr_reader_task(stderr, inner.clone()));
        tokio::spawn(exit_wait_task(child, inner.clone()));

        Ok(OmpProcess { inner })
    }

    /// Runs the ready handshake on a `connect`ed process, tearing it down itself on failure.
    pub async fn wait_ready(&self, opts: &OmpProcessOptions) -> Result<(), ProcessError> {
        if let Err(err) = wait_for_ready(
            self,
            opts,
            self.inner.spawned_at,
            self.inner.spawned_at_system,
        )
        .await
        {
            self.stop().await;
            return Err(err);
        }
        Ok(())
    }

    /// Combined `connect` + `wait_ready`, for callers that need not subscribe before the wait.
    pub async fn spawn(opts: OmpProcessOptions) -> Result<Self, ProcessError> {
        let process = Self::connect(&opts).await?;
        process.wait_ready(&opts).await?;
        Ok(process)
    }

    pub fn pid(&self) -> Option<u32> {
        let pid = self.inner.pid.load(Ordering::SeqCst);
        if pid == 0 {
            None
        } else {
            Some(pid as u32)
        }
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<ProcessEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.events_subs.lock().unwrap().push(tx);
        rx
    }

    /// Sends `cmd` with a fresh `id` (overwriting any caller value) and resolves on the matching
    /// `response`, or fails on timeout.
    pub async fn request(&self, mut cmd: Value, timeout_ms: u64) -> Result<Value, ProcessError> {
        if self.inner.exited.load(Ordering::SeqCst) {
            return Err(ProcessError::new("OmpProcess: process has exited"));
        }
        let cmd_type = cmd
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let id = format!(
            "refract-{}",
            self.inner.request_counter.fetch_add(1, Ordering::SeqCst) + 1
        );
        match cmd.as_object_mut() {
            Some(map) => {
                map.insert("id".to_string(), Value::String(id.clone()));
            }
            None => {
                return Err(ProcessError::new(
                    "OmpProcess: request command must be a JSON object",
                ))
            }
        }

        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id.clone(), tx);
        let sent_at = Instant::now();
        if let Err(err) = self.write_line(&cmd).await {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => {
                self.inner.latency.record(&cmd_type, sent_at.elapsed());
                result
            }
            Ok(Err(_)) => Err(ProcessError::new(format!(
                "OmpProcess: request cancelled ({cmd_type})"
            ))),
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(ProcessError::new(format!(
                    "OmpProcess: request timed out after {timeout_ms}ms ({cmd_type})"
                )))
            }
        }
    }

    /// Writes `value` to stdin verbatim: no `id` injection, no response wait. Used for
    /// `extension_ui_response`, whose `id` must stay the original request's id.
    pub async fn send_raw(&self, value: Value) -> Result<(), ProcessError> {
        if self.inner.exited.load(Ordering::SeqCst) {
            return Err(ProcessError::new("OmpProcess: process has exited"));
        }
        self.write_line(&value).await
    }

    /// Writes one JSON object to stdin as a newline-delimited frame.
    async fn write_line(&self, value: &Value) -> Result<(), ProcessError> {
        let mut data = serde_json::to_vec(value).map_err(|err| {
            ProcessError::new(format!("OmpProcess: failed to serialize command: {err}"))
        })?;
        data.push(b'\n');
        let mut guard = self.inner.stdin.lock().await;
        match guard.as_mut() {
            Some(stdin) => stdin
                .write_all(&data)
                .await
                .map_err(|err| ProcessError::new(format!("OmpProcess: stdin write failed: {err}"))),
            None => Err(ProcessError::new("OmpProcess: stdin is closed")),
        }
    }

    /// Idempotent: close stdin, wait up to `STOP_GRACE_MS`, then `taskkill /PID <pid> /T /F`.
    pub async fn stop(&self) {
        self.inner.requested_stop.store(true, Ordering::SeqCst);
        let inner = self.inner.clone();
        self.inner
            .stop_cell
            .get_or_init(move || do_stop(inner))
            .await;
    }
}

async fn do_stop(inner: Arc<Inner>) {
    if inner.exited.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut guard = inner.stdin.lock().await;
        // Dropping the `ChildStdin` closes the pipe's write end.
        *guard = None;
    }
    let exited = wait_for_exit_or_timeout(&inner, STOP_GRACE_MS).await;
    if !exited {
        hard_kill(&inner).await;
    }
}

async fn wait_for_exit_or_timeout(inner: &Arc<Inner>, timeout_ms: u64) -> bool {
    let mut rx = inner.exit_tx.subscribe();
    if inner.exited.load(Ordering::SeqCst) {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => inner.exited.load(Ordering::SeqCst),
        changed = rx.changed() => changed.is_ok(),
    }
}

async fn hard_kill(inner: &Arc<Inner>) {
    let pid = inner.pid.load(Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    let mut rx = inner.exit_tx.subscribe();
    if inner.exited.load(Ordering::SeqCst) {
        return;
    }
    let taskkill = executables::taskkill_path();
    let _ = Command::new(&taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    // taskkill /F is reliable; wait for the real `exit` event rather than a second timeout.
    if !inner.exited.load(Ordering::SeqCst) {
        let _ = rx.changed().await;
    }
}

async fn exit_wait_task(mut child: Child, inner: Arc<Inner>) {
    let status = child.wait().await;
    let code = status.ok().and_then(|status| status.code());
    inner.on_exit(code);
}

async fn stdout_reader_task(mut stdout: ChildStdout, inner: Arc<Inner>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut read_buf = [0u8; 8192];
    // Bytes before this index are known newline-free, so a long line is not rescanned per read.
    let mut scanned = 0usize;
    loop {
        let n = match stdout.read(&mut read_buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) => {
                log::error!("OmpProcess: stdout read error: {err}");
                break;
            }
        };
        buf.extend_from_slice(&read_buf[..n]);
        while let Some(rel) = buf[scanned..].iter().position(|&b| b == b'\n') {
            let pos = scanned + rel;
            let line = String::from_utf8_lossy(&buf[..pos]).into_owned();
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                handle_line(trimmed, &inner);
            }
            // Positions shift after this drain, so the next search restarts from the front.
            buf.drain(..=pos);
            scanned = 0;
        }
        scanned = buf.len();
        if buf.len() as u64 > MAX_REASSEMBLED_BYTES {
            log::error!("OmpProcess: stdout buffered {} bytes with no newline (ceiling {MAX_REASSEMBLED_BYTES}); dropping", buf.len());
            buf.clear();
            scanned = 0;
        }
    }
}

async fn stderr_reader_task(mut stderr: ChildStderr, inner: Arc<Inner>) {
    let mut read_buf = [0u8; 4096];
    loop {
        let n = match stderr.read(&mut read_buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let mut tail = inner.stderr_tail.lock().unwrap();
        tail.buf.extend_from_slice(&read_buf[..n]);
        if tail.buf.len() > STDERR_TAIL_BYTES {
            let excess = tail.buf.len() - STDERR_TAIL_BYTES;
            tail.buf.drain(..excess);
            tail.truncated = true;
        }
    }
}

fn handle_line(line: &str, inner: &Arc<Inner>) {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            // Logs length only: a stdout line can carry secrets.
            log::error!(
                "OmpProcess: skipping unparseable stdout line: {err} (length {} bytes)",
                line.len()
            );
            return;
        }
    };
    handle_parsed(parsed, inner);
}

fn handle_parsed(parsed: Value, inner: &Arc<Inner>) {
    let frame_type = match parsed.get("type").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => {
            // Logs length only: same reason as the unparseable-line case.
            log::error!(
                "OmpProcess: skipping malformed frame (no string type), length {} bytes",
                parsed.to_string().len()
            );
            return;
        }
    };
    if frame_type == "rpc_chunk" {
        handle_chunk(parsed, inner);
        return;
    }
    dispatch_frame(&frame_type, parsed, inner);
}

fn dispatch_frame(frame_type: &str, frame: Value, inner: &Arc<Inner>) {
    if frame_type == "response" {
        let id = frame.get("id").and_then(Value::as_str).map(str::to_string);
        if let Some(id) = id {
            let sender = inner.pending.lock().unwrap().remove(&id);
            if let Some(tx) = sender {
                let _ = tx.send(Ok(frame));
            }
        }
        // Responses are consumed by request() only; they are never broadcast as a frame.
        return;
    }
    if frame_type == "ready" {
        // Recorded BEFORE `broadcast_event`; see `Inner::ready_frame` (#512).
        *inner.ready_frame.lock().unwrap() = Some(frame.clone());
    }
    broadcast_event(inner, ProcessEvent::Frame(frame));
}

/// rpc_chunk reassembly: validates `chunkId`/`index`/`count`/`byteLength`, rejects interleaved or
/// duplicate sequences, enforces the 64 MiB ceiling and decodes strictly as UTF-8. Any failure
/// drops the assembly and fails every pending request.
fn handle_chunk(frame: Value, inner: &Arc<Inner>) {
    if let Err(err) = try_handle_chunk(&frame, inner) {
        log::error!("OmpProcess: dropping malformed rpc_chunk: {err}");
        let rejection =
            format!("OmpProcess: request failed: a chunked response failed reassembly ({err})");
        let mut pending = inner.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(ProcessError::new(rejection.clone())));
        }
    }
}

fn try_handle_chunk(frame: &Value, inner: &Arc<Inner>) -> Result<(), String> {
    let chunk_id = frame
        .get("chunkId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "rpc_chunk missing chunkId".to_string())?
        .to_string();
    let count = frame
        .get("count")
        .and_then(Value::as_i64)
        .filter(|&c| c > 0)
        .ok_or_else(|| format!("rpc_chunk {chunk_id}: invalid count"))?;
    let index = frame
        .get("index")
        .and_then(Value::as_i64)
        .filter(|&i| i >= 0 && i < count)
        .ok_or_else(|| format!("rpc_chunk {chunk_id}: invalid index"))?;
    let byte_length = frame
        .get("byteLength")
        .and_then(Value::as_i64)
        .filter(|&b| b >= 0)
        .ok_or_else(|| format!("rpc_chunk {chunk_id}: invalid byteLength"))?;
    if byte_length as u64 > MAX_REASSEMBLED_BYTES {
        return Err(format!("rpc_chunk {chunk_id}: byteLength {byte_length} exceeds {MAX_REASSEMBLED_BYTES} byte ceiling"));
    }
    let data = frame
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("rpc_chunk {chunk_id}: missing data"))?;
    let decoded = base64_decode(data)
        .map_err(|err| format!("rpc_chunk {chunk_id}: invalid base64 ({err})"))?;

    let mut chunks = inner.chunks.lock().unwrap();
    let ready = {
        let assembly = chunks
            .entry(chunk_id.clone())
            .or_insert_with(|| ChunkAssembly {
                parts: vec![None; count as usize],
                got: 0,
                byte_length: byte_length as u64,
            });
        if assembly.parts.len() != count as usize || assembly.byte_length != byte_length as u64 {
            chunks.remove(&chunk_id);
            return Err("interleaved sequence (count/byteLength changed mid-assembly)".to_string());
        }
        if assembly.parts[index as usize].is_some() {
            chunks.remove(&chunk_id);
            return Err(format!("duplicate index {index} (interleaved sequence)"));
        }
        assembly.parts[index as usize] = Some(decoded);
        assembly.got += 1;
        assembly.got == assembly.parts.len()
    };
    if !ready {
        return Ok(());
    }
    let completed = chunks
        .remove(&chunk_id)
        .expect("just inserted/updated above");
    drop(chunks);

    let mut whole = Vec::with_capacity(completed.byte_length as usize);
    for (i, part) in completed.parts.into_iter().enumerate() {
        whole.extend_from_slice(&part.ok_or_else(|| format!("missing part {i} after completion"))?);
    }
    if whole.len() as u64 != completed.byte_length {
        return Err(format!(
            "got {} bytes, expected {}",
            whole.len(),
            completed.byte_length
        ));
    }
    let text = String::from_utf8(whole)
        .map_err(|_| "reassembled payload is not valid UTF-8".to_string())?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|err| format!("reassembled payload is not valid JSON: {err}"))?;
    handle_parsed(parsed, inner);
    Ok(())
}

/// Standard (RFC 4648) base64 decoder; no `base64` crate is a dependency.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let stripped: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    if stripped.len() % 4 == 1 {
        return Err("invalid length".to_string());
    }

    let mut out = Vec::with_capacity(stripped.len() * 3 / 4 + 3);
    let mut group = [0u8; 4];
    let mut group_len = 0usize;
    for byte in stripped {
        let v = value(byte).ok_or_else(|| "invalid character".to_string())?;
        group[group_len] = v;
        group_len += 1;
        if group_len == 4 {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
            out.push((group[2] << 6) | group[3]);
            group_len = 0;
        }
    }
    match group_len {
        0 => {}
        2 => out.push((group[0] << 2) | (group[1] >> 4)),
        3 => {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
        }
        _ => return Err("invalid length".to_string()),
    }
    Ok(out)
}

async fn finish_ready(process: &OmpProcess, ready_frame: &Value) -> Result<(), ProcessError> {
    let supports_v2 = ready_frame
        .get("supportedProtocolVersions")
        .and_then(Value::as_array)
        .map(|versions| versions.iter().any(|v| v.as_i64() == Some(2)))
        .unwrap_or(false);
    if supports_v2 {
        let response = process
            .request(
                json!({ "type": "negotiate_protocol", "protocolVersion": 2 }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await?;
        let success = response
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !success {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(ProcessError::new(format!(
                "negotiate_protocol failed: {}",
                crate::omp::redact::redact_secrets(error)
            )));
        }
    }
    Ok(())
}

async fn wait_for_ready(
    process: &OmpProcess,
    opts: &OmpProcessOptions,
    spawned_at: Instant,
    spawned_at_system: SystemTime,
) -> Result<(), ProcessError> {
    let mut events_rx = process.subscribe();
    let mut exit_rx = process.inner.exit_tx.subscribe();
    // Both subscriptions were taken after `connect` started the readers, so an early `ready` or
    // exit reached neither; a fresh `watch` receiver only fires on the NEXT update. Re-check the
    // recorded state here instead of sitting out the ceiling (#512).
    let already_ready = process.inner.ready_frame.lock().unwrap().clone();
    if let Some(ready_frame) = already_ready {
        return finish_ready(process, &ready_frame).await;
    }
    if process.inner.exited.load(Ordering::SeqCst) {
        let already_exited = exit_rx.borrow_and_update().clone();
        if let Some(info) = already_exited {
            let reason = format!("process exited before ready (code {:?})", info.code);
            return Err(build_start_failure(&process.inner, reason, spawned_at_system).await);
        }
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(1_000));
    ticker.tick().await; // the first tick fires immediately; skip it

    loop {
        tokio::select! {
            frame = events_rx.recv() => {
                match frame {
                    Some(ProcessEvent::Frame(value)) => {
                        if value.get("type").and_then(Value::as_str) == Some("ready") {
                            return finish_ready(process, &value).await;
                        }
                    }
                    Some(_) => {}
                    // The unbounded channel never lags; it closes only when the process is gone.
                    None => {
                        return Err(ProcessError::new("OmpProcess: event stream closed before ready"));
                    }
                }
            }
            changed = exit_rx.changed() => {
                if changed.is_ok() {
                    // Clone out first: `watch::Ref` is not `Send` and must not live across the await.
                    let exited = exit_rx.borrow_and_update().clone();
                    if let Some(info) = exited {
                        let reason = format!("process exited before ready (code {:?})", info.code);
                        return Err(build_start_failure(&process.inner, reason, spawned_at_system).await);
                    }
                }
            }
            _ = ticker.tick() => {
                let elapsed_ms = u64::try_from(spawned_at.elapsed().as_millis()).unwrap_or(u64::MAX);
                if elapsed_ms >= opts.ready_ceiling_ms {
                    let reason = format!("ready frame not seen within {}s", elapsed_ms / 1000);
                    let mut err = build_start_failure(&process.inner, reason, spawned_at_system).await;
                    err.ready_ceiling = true;
                    return Err(err);
                }
                let stage = if elapsed_ms >= opts.ready_prompt_after_ms { ReadyWaitStage::Prompt } else { ReadyWaitStage::Waiting };
                broadcast_event(&process.inner, ProcessEvent::StartProgress { stage, elapsed_ms });
            }
        }
    }
}

/// Builds the start-failure message: stderr tail plus the pid's `~/.omp/logs` tail (#512), with
/// home-dir masking and `redact_secrets` applied.
async fn build_start_failure(
    inner: &Arc<Inner>,
    reason: String,
    spawned_at_system: SystemTime,
) -> ProcessError {
    let pid = inner.pid.load(Ordering::SeqCst);

    let (stderr_text, stderr_truncated) = {
        let tail = inner.stderr_tail.lock().unwrap();
        (
            String::from_utf8_lossy(&tail.buf).into_owned(),
            tail.truncated,
        )
    };
    let stderr_for_redaction = if stderr_truncated {
        match stderr_text.find('\n') {
            Some(idx) => stderr_text[idx + 1..].to_string(),
            None => String::new(),
        }
    } else {
        stderr_text
    };
    // Order matters: filter -> cap -> redact. `redact_secrets` keeps only its last ~8 KiB, so
    // redacting first could drop warn/error lines the filter exists to surface; redacting last
    // also keeps its fail-closed placeholder from being filtered back out.
    let stderr_filtered = filter_warn_error_lines(&stderr_for_redaction);
    let stderr_capped = cap_tail(&stderr_filtered, STDERR_FAILURE_TAIL_BYTES);
    let stderr_redacted = crate::omp::redact::redact_secrets(&mask_home_dir(&stderr_capped));
    let stderr_part = if stderr_capped.is_empty() {
        String::new()
    } else {
        format!("\n--- stderr warnings/errors ---\n{stderr_redacted}")
    };

    let omp_log_part = if pid != 0 {
        match read_omp_log_tail(pid as u32, spawned_at_system, OMP_LOG_READ_WINDOW_BYTES).await {
            Some(raw) => {
                let filtered = filter_warn_error_lines(&raw);
                let capped = cap_tail(&filtered, OMP_LOG_TAIL_BYTES);
                let redacted = crate::omp::redact::redact_secrets(&mask_home_dir(&capped));
                if capped.is_empty() {
                    String::new()
                } else {
                    format!("\n--- omp log warnings/errors (pid {pid}) ---\n{redacted}")
                }
            }
            None => String::new(),
        }
    } else {
        String::new()
    };

    ProcessError::new(format!("OmpProcess: {reason}{stderr_part}{omp_log_part}"))
}

fn filter_warn_error_lines(text: &str) -> String {
    const NEEDLES: &[&str] = &[
        "warn",
        "error",
        "fatal",
        "panic",
        "exception",
        "cannot",
        "failed",
        "enoent",
        "eacces",
        "eperm",
        "timed out",
    ];
    let lines: Vec<&str> = text.lines().collect();
    let filtered: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            NEEDLES.iter().any(|needle| lower.contains(needle))
                || lower.contains("\"level\":\"warn\"")
                || lower.contains("\"level\":\"error\"")
        })
        .collect();
    if !filtered.is_empty() {
        return filtered.join("\n");
    }
    let start = lines.len().saturating_sub(20);
    lines[start..].join("\n")
}

/// Keeps at most the last `max_len` bytes of `text`, dropping a partial leading line.
fn cap_tail(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let mut start = text.len() - max_len;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut_mid_line = start > 0 && text.as_bytes()[start - 1] != b'\n';
    if !cut_mid_line {
        return text[start..].to_string();
    }
    match text[start..].find('\n') {
        Some(idx) => text[start + idx + 1..].to_string(),
        None => String::new(),
    }
}

fn mask_home_dir(text: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return text.to_string();
    };
    let backslashes = home.to_string_lossy().into_owned();
    let forward_slashes = backslashes.replace('\\', "/");
    let mut result = text.replace(&backslashes, "~");
    if forward_slashes != backslashes {
        result = result.replace(&forward_slashes, "~");
    }
    result
}

/// The newest `~/.omp/logs/*.{pid}.log` whose mtime is at or after `spawned_at`, tailed to
/// `max_bytes`. Uses `symlink_metadata` so a symlink is never followed.
async fn read_omp_log_tail(pid: u32, spawned_at: SystemTime, max_bytes: u64) -> Option<String> {
    let home = dirs::home_dir()?;
    let logs_dir = home.join(".omp").join("logs");
    let suffix = format!(".{pid}.log");

    let mut newest: Option<(SystemTime, PathBuf)> = None;
    let mut entries = tokio::fs::read_dir(&logs_dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(&suffix) {
            continue;
        }
        let path = entry.path();
        let metadata = tokio::fs::symlink_metadata(&path).await.ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < spawned_at {
            continue;
        }
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, path));
        }
    }
    let (_, path) = newest?;
    read_tail_bytes(&path, max_bytes).await
}

/// A seek can land mid-line, leaving a credential fragment the redactor cannot recognise; when
/// the seek moved, drop everything up to the first newline so only complete lines return.
async fn read_tail_bytes(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return Some(text);
    }
    Some(match text.find('\n') {
        Some(idx) => text[idx + 1..].to_string(),
        None => String::new(),
    })
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod process_tests;
