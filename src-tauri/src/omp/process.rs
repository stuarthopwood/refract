// Port of `src/main/omp/OmpProcess.ts` (tasks.md T011): drives one `omp --mode rpc-ui` child
// process for a Session's own worktree (FR-001 to FR-005). This module owns process *lifecycle*
// only -- spawn, JSONL framing (0x0A-delimited), `rpc_chunk` reassembly, request/response
// correlation with per-request timeouts, the staged ready-wait (issue #512), and stop/
// force-kill. It deliberately does NOT model the full `omp` wire-protocol frame union
// (`src/shared/frames.ts`): non-response frames are forwarded to subscribers as raw
// `serde_json::Value`, left for `omp::transcript` (Phase 2(c), OMP frame -> `TranscriptItem`)
// and `session::agent` (Phase 3) to decode further -- the same separation `OmpProcess.ts` itself
// has from `transcript.ts` via its own `'frame'` event.
//
// Deliberately NOT ported from `OmpProcess.ts` in this slice (process-level lifecycle only, not
// Session-level orchestration -- none of the three are named by FR-001 to FR-005 or by tasks.md's
// own T011 description, and all three coordinate across multiple Sessions/the whole app, which is
// `session::manager`'s layer in Phase 3, not one process's own wrapper):
//   - the process-wide start queue (`startQueue.ts`'s `acquireStartSlot`/`MAX_CONCURRENT_STARTS`);
//   - the low-memory start defer (`memory.ts`'s `isMemoryLow`);
//   - the pid-record fallback (`process/pidRecords.ts`) -- Job Object kill-on-close (FR-005) is
//     the mechanism FR-001 to FR-005 actually require; the pid-record file is Electron's own
//     secondary belt-and-braces path, not named here.
// See this file's final report for the two Cargo.toml-less workarounds this slice needed (a
// hand-rolled base64 decoder in place of a `base64` crate, and a conservative whole-line
// redaction heuristic in place of `redact.ts`'s full regex set, since neither `base64` nor
// `regex` is a declared dependency).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
// `parking_lot::Mutex` is the project's preferred sync-mutex (no poisoning to unwrap) but is not
// a declared dependency of this crate and Cargo.toml must not be edited in this slice; `pending`/
// `chunks`/`stderr_tail` below use `std::sync::Mutex` instead, with the usual `.lock().unwrap()`
// (poisoning only follows a panic while holding the lock, which none of these critical sections
// can do). See the final report for the stated need to add `parking_lot`.
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{broadcast, oneshot, watch, Mutex as TokioMutex};
use tokio::time::Instant;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::process::executables;

// Issue #512: READY_PROMPT_AFTER_MS is the point at which a caller should offer "Keep waiting"/
// "Cancel" (not ported here -- no interactive cancel surface exists in this process-lifecycle
// slice); the wait keeps going regardless, up to READY_CEILING_MS, where it fails outright.
const READY_PROMPT_AFTER_MS: u64 = 60_000;
const READY_CEILING_MS: u64 = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const STOP_GRACE_MS: u64 = 10_000;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
const STDERR_FAILURE_TAIL_BYTES: usize = 2 * 1024;
const OMP_LOG_READ_WINDOW_BYTES: u64 = 64 * 1024;
const OMP_LOG_TAIL_BYTES: usize = 4 * 1024;
// FINDINGS C22b: v1 frames are capped at maxFrameBytes; a reassembled rpc_chunk sequence above
// this ceiling is treated as corrupt rather than buffered without bound. Reused as the same
// ceiling for a single 0x0A-delimited stdout line that never terminates (defence in depth: the
// Electron port has no such cap on a raw stdout line, only on chunk reassembly, but an unbounded
// `Vec<u8>` on a line that never sees a newline would otherwise grow forever).
const MAX_REASSEMBLED_BYTES: u64 = 64 * 1024 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Settings.approvalMode (`src/shared/model.ts`), re-declared here rather than imported (no
/// shared Rust `model` crate exists yet; `store::settings`, Phase 2(b), is the natural home for a
/// canonical copy once it lands). Serialises with the same string values as
/// `OMP_APPROVAL_MODE`'s own keys for any caller that round-trips this through JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    EditFreely,
    Auto,
}

impl ApprovalMode {
    /// Maps to the value OMP's `--approval-mode` flag expects (`src/shared/model.ts`'s
    /// `OMP_APPROVAL_MODE`).
    fn omp_flag(self) -> &'static str {
        match self {
            ApprovalMode::Ask => "always-ask",
            ApprovalMode::EditFreely => "write",
            ApprovalMode::Auto => "yolo",
        }
    }
}

/// Port of `OmpProcessOptions` (`OmpProcess.ts`), narrowed to the fields this slice's spawn/
/// ready-wait/stop lifecycle actually uses (`sessionId` drove `pidRecords.ts`, out of scope here;
/// the start-queue/memory-defer overrides have no queue/defer left to override).
pub struct OmpProcessOptions {
    pub cwd: PathBuf,
    pub approval_mode: ApprovalMode,
    pub omp_path: Option<PathBuf>,
    /// Appends `--no-session` (omp-usage.md; issue #362). See `OmpProcessOptions.noSession`'s own
    /// doc comment in `OmpProcess.ts` for the persistence caveat.
    pub no_session: bool,
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
            ready_prompt_after_ms: READY_PROMPT_AFTER_MS,
            ready_ceiling_ms: READY_CEILING_MS,
        }
    }
}

/// Mirrors `OmpProcess.ts`'s thrown `Error`s: a plain message, plus a flag distinguishing the
/// ready-wait's own ceiling outcome (`ReadyCeilingError`) from every other failure, so a future
/// caller (`session::agent`'s one-shot retry, Phase 3) can branch on it without regex-matching
/// `message` the way a `instanceof` check would in TS.
#[derive(Debug, Clone)]
pub struct ProcessError {
    pub message: String,
    pub ready_ceiling: bool,
}

impl ProcessError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), ready_ceiling: false }
    }
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProcessError {}

/// Staged ready-wait progress (issue #512, `readyWait.ts`'s own `ReadyWaitStageKind`), narrowed to
/// the two stages that matter with no interactive cancel/keep-waiting surface in this slice:
/// `Extended` (user clicked "Keep waiting") and `Ceiling`-as-a-stage have no caller to drive them
/// here, so the ceiling outcome is reported as a `ProcessError` (`ready_ceiling: true`) instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyWaitStage {
    Waiting,
    Prompt,
}

/// Port of `OmpProcess.ts`'s own `'exit'` event payload.
#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub requested: bool,
}

/// Everything a subscriber (`subscribe()`) can observe about a running `OmpProcess`, except
/// responses to its own `request()` calls (consumed internally, never broadcast -- same rule
/// `OmpProcess.ts`'s own `dispatchFrame` enforces for `'frame'`).
#[derive(Debug, Clone)]
pub enum ProcessEvent {
    /// Every decoded frame except `response` (consumed by `request()`) and `rpc_chunk` (consumed
    /// internally for reassembly, then re-dispatched as the frame it decodes to). Port of
    /// `OmpProcess.ts`'s own `'frame'` event.
    Frame(Value),
    /// Port of `OmpProcess.ts`'s own `'start-progress'` event.
    StartProgress { stage: ReadyWaitStage, elapsed_ms: u64 },
    /// Fires exactly once. Port of `OmpProcess.ts`'s own `'exit'` event.
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
    pending: StdMutex<HashMap<String, oneshot::Sender<Result<Value, ProcessError>>>>,
    chunks: StdMutex<HashMap<String, ChunkAssembly>>,
    stderr_tail: StdMutex<StderrTail>,
    stdin: TokioMutex<Option<tokio::process::ChildStdin>>,
    events_tx: broadcast::Sender<ProcessEvent>,
    exit_tx: watch::Sender<Option<ExitInfo>>,
    stop_cell: tokio::sync::OnceCell<()>,
}

impl Inner {
    /// Idempotent: a second call (there should never be one, but `child.wait()` resolving twice
    /// would be a tokio bug, not an app one) is a silent no-op, matching `OmpProcess.ts`'s own
    /// `exitEmitted` guard.
    fn on_exit(&self, code: Option<i32>) {
        if self.exited.swap(true, Ordering::SeqCst) {
            return;
        }
        let requested = self.requested_stop.load(Ordering::SeqCst);
        let info = ExitInfo { code, requested };
        let _ = self.exit_tx.send(Some(info));
        let _ = self.events_tx.send(ProcessEvent::Exit { code, requested });
        // The process is gone: nothing will ever answer an in-flight request, so fail every one
        // of them now rather than let each wait out its own timeout.
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(ProcessError::new(format!("OmpProcess: process exited (code {code:?})"))));
        }
    }
}

/// One running (or ready-waiting) `omp --mode rpc-ui` child process.
pub struct OmpProcess {
    inner: Arc<Inner>,
}

fn build_args(opts: &OmpProcessOptions) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc-ui".to_string(), format!("--approval-mode={}", opts.approval_mode.omp_flag())];
    if opts.no_session {
        args.push("--no-session".to_string());
    }
    args
}

impl OmpProcess {
    /// Spawns `omp` and resolves once the ready handshake (and v2 protocol negotiation) completes
    /// (FR-001, FR-002). Unlike `OmpProcess.ts`'s own two-phase constructor-then-`start()` (where
    /// the caller already holds a reference to `this.child` even if the ready-wait itself fails,
    /// so it can still `stop()` it), this port's `spawn()` is the single combined entry point the
    /// Phase 3 API contract calls for; to avoid leaking a live `omp` child when the ready-wait
    /// fails (ceiling or an exit-before-ready race) with no handle ever reaching the caller, this
    /// function tears the process down itself (via the same `stop()` a caller would otherwise
    /// use) before returning `Err`.
    pub async fn spawn(opts: OmpProcessOptions) -> Result<Self, ProcessError> {
        executables::ensure_no_default_cwd_in_exe_path();
        let omp_path = match &opts.omp_path {
            Some(path) => path.clone(),
            None => executables::resolve_omp().map_err(ProcessError::new)?,
        };
        let args = build_args(&opts);

        let mut command = Command::new(&omp_path);
        command
            .args(&args)
            .current_dir(&opts.cwd)
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
        let stdin = child.stdin.take().ok_or_else(|| ProcessError::new("OmpProcess: stdin not piped"))?;
        let stdout = child.stdout.take().ok_or_else(|| ProcessError::new("OmpProcess: stdout not piped"))?;
        let stderr = child.stderr.take().ok_or_else(|| ProcessError::new("OmpProcess: stderr not piped"))?;

        let (events_tx, _events_rx) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (exit_tx, _exit_rx) = watch::channel(None);

        let inner = Arc::new(Inner {
            pid: AtomicU64::new(pid as u64),
            requested_stop: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            request_counter: AtomicU64::new(0),
            pending: StdMutex::new(HashMap::new()),
            chunks: StdMutex::new(HashMap::new()),
            stderr_tail: StdMutex::new(StderrTail::default()),
            stdin: TokioMutex::new(Some(stdin)),
            events_tx,
            exit_tx,
            stop_cell: tokio::sync::OnceCell::new(),
        });

        tokio::spawn(stdout_reader_task(stdout, inner.clone()));
        tokio::spawn(stderr_reader_task(stderr, inner.clone()));
        tokio::spawn(exit_wait_task(child, inner.clone()));

        let process = OmpProcess { inner };
        if let Err(err) = wait_for_ready(&process, &opts, spawned_at, spawned_at_system).await {
            process.stop().await;
            return Err(err);
        }
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

    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.inner.events_tx.subscribe()
    }

    /// Sends `cmd` (a JSON object; `id` is injected here, overwriting any caller-supplied value)
    /// with a fresh unique id and resolves on the matching `response` frame, or fails on timeout
    /// (FR-003). Port of `OmpProcess.ts`'s own `request`.
    pub async fn request(&self, mut cmd: Value, timeout_ms: u64) -> Result<Value, ProcessError> {
        if self.inner.exited.load(Ordering::SeqCst) {
            return Err(ProcessError::new("OmpProcess: process has exited"));
        }
        let cmd_type = cmd.get("type").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let id = format!("refract-{}", self.inner.request_counter.fetch_add(1, Ordering::SeqCst) + 1);
        match cmd.as_object_mut() {
            Some(map) => {
                map.insert("id".to_string(), Value::String(id.clone()));
            }
            None => return Err(ProcessError::new("OmpProcess: request command must be a JSON object")),
        }

        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(err) = self.write_line(&cmd).await {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ProcessError::new(format!("OmpProcess: request cancelled ({cmd_type})"))),
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(ProcessError::new(format!("OmpProcess: request timed out after {timeout_ms}ms ({cmd_type})")))
            }
        }
    }

    /// Writes one JSON object to stdin as a newline-delimited frame. Port of `OmpProcess.ts`'s
    /// own `write`.
    async fn write_line(&self, value: &Value) -> Result<(), ProcessError> {
        let mut data = serde_json::to_vec(value).map_err(|err| ProcessError::new(format!("OmpProcess: failed to serialize command: {err}")))?;
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

    pub async fn wait_exit(&self) -> ExitInfo {
        let mut rx = self.inner.exit_tx.subscribe();
        loop {
            if let Some(info) = rx.borrow_and_update().clone() {
                return info;
            }
            if rx.changed().await.is_err() {
                return ExitInfo { code: None, requested: false };
            }
        }
    }

    /// Idempotent: stdin close, wait up to `STOP_GRACE_MS`, then force-kill the whole process
    /// tree via `taskkill /PID <pid> /T /F` (FR-004). Port of `OmpProcess.ts`'s own `stop`.
    pub async fn stop(&self) {
        self.inner.requested_stop.store(true, Ordering::SeqCst);
        let inner = self.inner.clone();
        self.inner.stop_cell.get_or_init(move || do_stop(inner)).await;
    }
}

async fn do_stop(inner: Arc<Inner>) {
    if inner.exited.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut guard = inner.stdin.lock().await;
        // Dropping the `ChildStdin` closes the pipe's write end, the same effect as
        // `child.stdin.end()` in the Electron port.
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
    // taskkill /F should be reliable; wait for the real `exit` event it triggers rather than a
    // second timeout, per contract ("resolve after exit") -- same as `OmpProcess.ts`'s own
    // `hardKill`.
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
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let remainder = buf.split_off(pos + 1);
            buf.truncate(pos);
            let line = String::from_utf8_lossy(&buf).into_owned();
            buf = remainder;
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                handle_line(trimmed, &inner);
            }
        }
        if buf.len() as u64 > MAX_REASSEMBLED_BYTES {
            log::error!("OmpProcess: stdout buffered {} bytes with no newline (ceiling {MAX_REASSEMBLED_BYTES}); dropping", buf.len());
            buf.clear();
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
            let preview: String = line.chars().take(200).collect();
            log::error!("OmpProcess: skipping unparseable stdout line: {err} ({preview})");
            return;
        }
    };
    handle_parsed(parsed, inner);
}

fn handle_parsed(parsed: Value, inner: &Arc<Inner>) {
    let frame_type = match parsed.get("type").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => {
            log::error!("OmpProcess: skipping malformed frame (no string type): {parsed}");
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
    let _ = inner.events_tx.send(ProcessEvent::Frame(frame));
}

/// rpc_chunk reassembly (FINDINGS C22b / contracts/omp-usage.md "Failure handling"): validates
/// `chunkId`/`index`/`count`/`byteLength`, rejects interleaved or duplicate sequences, enforces
/// the 64 MiB reassembled ceiling, and decodes strictly as UTF-8. Any failure drops the whole
/// in-flight assembly and fails every pending request, same as an unparseable line would be worse
/// to hang on silently.
fn handle_chunk(frame: Value, inner: &Arc<Inner>) {
    if let Err(err) = try_handle_chunk(&frame, inner) {
        log::error!("OmpProcess: dropping malformed rpc_chunk: {err}");
        let rejection = format!("OmpProcess: request failed: a chunked response failed reassembly ({err})");
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
    let data = frame.get("data").and_then(Value::as_str).ok_or_else(|| format!("rpc_chunk {chunk_id}: missing data"))?;
    let decoded = base64_decode(data).map_err(|err| format!("rpc_chunk {chunk_id}: invalid base64 ({err})"))?;

    let mut chunks = inner.chunks.lock().unwrap();
    let ready = {
        let assembly = chunks.entry(chunk_id.clone()).or_insert_with(|| ChunkAssembly {
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
    let completed = chunks.remove(&chunk_id).expect("just inserted/updated above");
    drop(chunks);

    let mut whole = Vec::with_capacity(completed.byte_length as usize);
    for (i, part) in completed.parts.into_iter().enumerate() {
        whole.extend_from_slice(&part.ok_or_else(|| format!("missing part {i} after completion"))?);
    }
    if whole.len() as u64 != completed.byte_length {
        return Err(format!("got {} bytes, expected {}", whole.len(), completed.byte_length));
    }
    let text = String::from_utf8(whole).map_err(|_| "reassembled payload is not valid UTF-8".to_string())?;
    let parsed: Value = serde_json::from_str(&text).map_err(|err| format!("reassembled payload is not valid JSON: {err}"))?;
    handle_parsed(parsed, inner);
    Ok(())
}

/// Standard (RFC 4648) base64 decoder. No `base64` crate is a declared dependency of this crate;
/// this hand-rolled decoder replaces `Buffer.from(data, 'base64')` for `rpc_chunk` reassembly
/// (see this file's own header note and the final report for the stated need).
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

    let stripped: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=').collect();
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
        let response = process.request(json!({ "type": "negotiate_protocol", "protocolVersion": 2 }), DEFAULT_REQUEST_TIMEOUT_MS).await?;
        let success = response.get("success").and_then(Value::as_bool).unwrap_or(false);
        if !success {
            let error = response.get("error").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(ProcessError::new(format!("negotiate_protocol failed: {}", redact_best_effort(error))));
        }
    }
    Ok(())
}

async fn wait_for_ready(process: &OmpProcess, opts: &OmpProcessOptions, spawned_at: Instant, spawned_at_system: SystemTime) -> Result<(), ProcessError> {
    let mut events_rx = process.inner.events_tx.subscribe();
    let mut exit_rx = process.inner.exit_tx.subscribe();
    let mut ticker = tokio::time::interval(Duration::from_millis(1_000));
    ticker.tick().await; // the first tick fires immediately; skip it

    loop {
        tokio::select! {
            frame = events_rx.recv() => {
                match frame {
                    Ok(ProcessEvent::Frame(value)) => {
                        if value.get("type").and_then(Value::as_str) == Some("ready") {
                            return finish_ready(process, &value).await;
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err(ProcessError::new("OmpProcess: event stream closed before ready"));
                    }
                }
            }
            changed = exit_rx.changed() => {
                if changed.is_ok() {
                    if let Some(info) = exit_rx.borrow_and_update().clone() {
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
                let _ = process.inner.events_tx.send(ProcessEvent::StartProgress { stage, elapsed_ms });
            }
        }
    }
}

/// Port of `OmpProcess.ts`'s own `buildStartFailure`, narrowed to what a dependency-free Rust
/// implementation can match exactly: the stderr tail, the pid's own `~/.omp/logs` tail (issue
/// #512 requirement 2), and best-effort home-dir masking/credential redaction. See this file's
/// header and the final report for the two things NOT ported at full fidelity (the free/total
/// memory line -- no declared crate exposes it without a new Windows feature flag -- and
/// `redact.ts`'s full regex set -- no `regex` crate is declared, so this uses a conservative
/// whole-line heuristic instead of exact per-pattern redaction).
async fn build_start_failure(inner: &Arc<Inner>, reason: String, spawned_at_system: SystemTime) -> ProcessError {
    let pid = inner.pid.load(Ordering::SeqCst);

    let (stderr_text, stderr_truncated) = {
        let tail = inner.stderr_tail.lock().unwrap();
        (String::from_utf8_lossy(&tail.buf).into_owned(), tail.truncated)
    };
    let stderr_for_redaction = if stderr_truncated {
        match stderr_text.find('\n') {
            Some(idx) => stderr_text[idx + 1..].to_string(),
            None => String::new(),
        }
    } else {
        stderr_text
    };
    let stderr_redacted = redact_best_effort(&mask_home_dir(&stderr_for_redaction));
    let stderr_filtered = filter_warn_error_lines(&stderr_redacted);
    let stderr_capped = cap_tail(&stderr_filtered, STDERR_FAILURE_TAIL_BYTES);
    let stderr_part = if stderr_capped.is_empty() { String::new() } else { format!("\n--- stderr warnings/errors ---\n{stderr_capped}") };

    let omp_log_part = if pid != 0 {
        match read_omp_log_tail(pid as u32, spawned_at_system, OMP_LOG_READ_WINDOW_BYTES).await {
            Some(raw) => {
                let redacted = redact_best_effort(&mask_home_dir(&raw));
                let filtered = filter_warn_error_lines(&redacted);
                let capped = cap_tail(&filtered, OMP_LOG_TAIL_BYTES);
                if capped.is_empty() { String::new() } else { format!("\n--- omp log warnings/errors (pid {pid}) ---\n{capped}") }
            }
            None => String::new(),
        }
    } else {
        String::new()
    };

    ProcessError::new(format!("OmpProcess: {reason}{stderr_part}{omp_log_part}"))
}

fn filter_warn_error_lines(text: &str) -> String {
    const NEEDLES: &[&str] = &["warn", "error", "fatal", "panic", "exception", "cannot", "failed", "enoent", "eacces", "eperm", "timed out"];
    let lines: Vec<&str> = text.lines().collect();
    let filtered: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            NEEDLES.iter().any(|needle| lower.contains(needle)) || lower.contains("\"level\":\"warn\"") || lower.contains("\"level\":\"error\"")
        })
        .collect();
    if !filtered.is_empty() {
        return filtered.join("\n");
    }
    let start = lines.len().saturating_sub(20);
    lines[start..].join("\n")
}

/// Keeps at most the last `max_len` bytes of `text`, dropping a partial leading line rather than
/// an arbitrary mid-line cut (same reasoning as `OmpProcess.ts`'s own `capTailLines`, simplified:
/// Rust `&str` slicing can only ever land on a UTF-8 char boundary, so the UTF-16 surrogate-pair
/// hazard that method guards against does not exist here).
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
    let Some(home) = dirs::home_dir() else { return text.to_string() };
    let backslashes = home.to_string_lossy().into_owned();
    let forward_slashes = backslashes.replace('\\', "/");
    let mut result = text.replace(&backslashes, "~");
    if forward_slashes != backslashes {
        result = result.replace(&forward_slashes, "~");
    }
    result
}

/// Conservative, dependency-free stand-in for `redact.ts`'s own `redactSecrets` (a 97-line, multi-
/// cycle gate-fixed regex set with no `regex` crate declared to port it against): redacts the
/// WHOLE line when any credential-shaped marker appears, rather than the original's precise
/// in-line substitution. Strictly more conservative (never under-redacts a line it flags; may
/// drop more surrounding context than the exact port would) -- see the final report for the
/// stated need to add the `regex` crate and finish the exact port.
fn redact_best_effort(text: &str) -> String {
    const MARKERS: &[&str] = &[
        "bearer ",
        "authorization:",
        "api_key",
        "apikey",
        "api-key",
        "token",
        "secret",
        "password",
        "passwd",
        "cookie:",
        "set-cookie:",
        "sk-ant-",
        "sk-proj-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "-----begin",
        "private_key",
        "access_key",
        "client_secret",
    ];
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if MARKERS.iter().any(|marker| lower.contains(marker)) {
                "[redacted: possible credential]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Port of `ompLogTail.ts`'s own `tailOmpLogForPid`: the newest `~/.omp/logs/*.{pid}.log` file
/// whose mtime is at or after `spawned_at`, tailed to `max_bytes`. Uses `symlink_metadata` (never
/// following a symlink) for the same reason the Electron port uses `lstat`, not `stat`.
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
        let Ok(modified) = metadata.modified() else { continue };
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

async fn read_tail_bytes(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}
