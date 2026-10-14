// Agent termination and orphan reaping (#515, #656 races), recovery and resume as a typed state
// machine (lane R3, issue #786). Pre-declared so lane R3 is the only lane that ever edits this
// file (issue #784, "Pre-declare per-lane Rust files").
//
// Port of three Electron modules: `src/main/omp/terminationDetection.ts` (tail-only crash
// detection, issue #510), `src/main/omp/stoppedOnRequestMarker.ts` (the persisted "this stop was
// requested, not a crash" marker and the shared `resolveTermination` gate), and the
// `SessionAgent.onExit` requested/crash branches that drive both (ported here, not in
// `agent/frame.rs`, per this lane's own extension-point contract -- see `agent/mod.rs`'s header).
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane R3 adds its termination/recovery behaviour inside
// these functions, never inside any file under `session/agent/`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::omp::process::ReadyWaitStage;
use crate::store::registry::{Session, SessionPatch};

use super::agent::SessionAgent;

/// Never read more than this many bytes from the tail of a Conversation file on the first pass
/// (issue #510: "no whole-file read"). Mirrors `terminationDetection.ts`'s own `TAIL_BYTES`.
const TAIL_BYTES: u64 = 256 * 1024;
/// Mirrors `terminationDetection.ts`'s own `MAX_TAIL_BYTES`: the doubling cap for the
/// single-oversized-line case.
const MAX_TAIL_BYTES: u64 = TAIL_BYTES * 8;

/// Lane R3's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_termination_state` accessor (`agent/mod.rs`), and read directly by
/// `agent/mod.rs`'s own `status_event_locked`/`runtime_view` (same module tree, `pub(super)`
/// fields) to embed `terminatedUnexpectedly`/`pendingToolNames` into the wire payload.
#[derive(Default)]
pub(super) struct State {
    /// This life's own in-memory flag (`SessionRuntime.stoppedOnRequest`): set by `on_exit`'s
    /// requested branch, cleared at the top of every `launch()` attempt
    /// (`clear_stopped_on_request_marker`). Lets `resolve_termination` skip the tail read
    /// entirely for a Session this life itself stopped on request.
    pub(super) stopped_on_request: bool,
    pub(super) terminated_unexpectedly: bool,
    pub(super) pending_tool_names: Vec<String>,
}

/// Port of `terminationDetection.ts`'s own `TerminationDetectionResult`, narrowed to the two
/// fields anything outside this module ever reads (`reason` is internal detail, not surfaced on
/// the wire -- `src/shared/ipc.ts`'s `SessionRuntimeView` only carries
/// `terminatedUnexpectedly`/`pendingToolNames`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct TerminationDetectionResult {
    pub(crate) terminated_unexpectedly: bool,
    pub(crate) pending_tool_names: Vec<String>,
}

impl TerminationDetectionResult {
    fn clean() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------------------------
// Tail-only crash detection (port of `terminationDetection.ts`)
// ---------------------------------------------------------------------------------------------

/// One raw `.jsonl` tail line, classified down to only the fields this module reads -- every
/// field access is narrowed against the actual JSON, never cast to an assumed interface, since a
/// stored Conversation line is disk content at the same trust level as `registry.json`.
enum TailLine {
    SessionExit {
        reason: Option<String>,
        pending_tool_calls: Option<Vec<String>>,
    },
    Assistant {
        tool_calls: Vec<(String, String)>,
    },
    ToolResult {
        tool_call_id: String,
    },
    User,
    Other,
}

fn parse_tail_line(line: &str) -> Option<TailLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Only the file's true last line can land here as a parse failure (see `read_tail_lines`): a
    // genuinely truncated write, treated as inconclusive rather than asserted as a specific
    // reason -- the caller still sees whatever earlier, fully-parsed lines in the window found.
    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    let obj = parsed.as_object()?;

    if obj.get("type").and_then(Value::as_str) == Some("session_exit") {
        let reason = obj
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let pending_tool_calls = obj
            .get("pendingToolCalls")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            });
        return Some(TailLine::SessionExit {
            reason,
            pending_tool_calls,
        });
    }

    if obj.get("type").and_then(Value::as_str) != Some("message") {
        return Some(TailLine::Other);
    }
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return Some(TailLine::Other);
    };
    match message.get("role").and_then(Value::as_str) {
        Some("assistant") => {
            let mut tool_calls = Vec::new();
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for part in content {
                    let Some(part_obj) = part.as_object() else {
                        continue;
                    };
                    if part_obj.get("type").and_then(Value::as_str) != Some("toolCall") {
                        continue;
                    }
                    if let (Some(id), Some(name)) = (
                        part_obj.get("id").and_then(Value::as_str),
                        part_obj.get("name").and_then(Value::as_str),
                    ) {
                        tool_calls.push((id.to_string(), name.to_string()));
                    }
                }
            }
            Some(TailLine::Assistant { tool_calls })
        }
        Some("toolResult") => message
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(|id| TailLine::ToolResult {
                tool_call_id: id.to_string(),
            })
            .or(Some(TailLine::Other)),
        Some("user") => Some(TailLine::User),
        _ => Some(TailLine::Other),
    }
}

struct Window {
    lines: Vec<String>,
    started_at_zero: bool,
}

/// Reads one window of `handle`, `window_bytes` wide, ending at its current size. Port of
/// `readWindow`.
async fn read_window(handle: &mut tokio::fs::File, window_bytes: u64) -> Option<Window> {
    let metadata = handle.metadata().await.ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Some(Window {
            lines: Vec::new(),
            started_at_zero: true,
        });
    }
    let size = metadata.len();
    let start = size.saturating_sub(window_bytes);
    let length = usize::try_from(size - start).ok()?;
    handle.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    let mut buffer = vec![0u8; length];
    let mut read_total = 0usize;
    while read_total < length {
        match handle.read(&mut buffer[read_total..]).await {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buffer[..read_total]);
    let lines = text.split('\n').map(str::to_string).collect();
    Some(Window {
        lines,
        started_at_zero: start == 0,
    })
}

/// Reads at most `TAIL_BYTES` (doubling up to `MAX_TAIL_BYTES` only for the pathological
/// single-oversized-line case) from the tail of `file`. Port of `readTailLines`. Never panics: a
/// missing, empty, or unreadable file (including a read that fails partway through) yields `[]`.
async fn read_tail_lines(file: &str) -> Vec<String> {
    let Ok(mut handle) = tokio::fs::File::open(file).await else {
        return Vec::new();
    };
    let mut window_bytes = TAIL_BYTES;
    loop {
        let Some(window) = read_window(&mut handle, window_bytes).await else {
            return Vec::new();
        };
        if window.started_at_zero {
            return window.lines;
        }
        // The window's own first line is always dropped here: it may be a fragment of an
        // earlier, larger line, never real evidence either way.
        let candidate: Vec<String> = window.lines.into_iter().skip(1).collect();
        let has_real_content = candidate.iter().any(|line| !line.trim().is_empty());
        if has_real_content || window_bytes >= MAX_TAIL_BYTES {
            return candidate;
        }
        window_bytes *= 2;
    }
}

async fn compute_detection(file: &str) -> TerminationDetectionResult {
    let lines = read_tail_lines(file).await;

    struct ExitRecord {
        reason: Option<String>,
        pending_tool_calls: Option<Vec<String>>,
    }
    let mut exit_record: Option<ExitRecord> = None;
    // `(toolCallId, toolName)`, insertion order preserved like the TS port's own `Map` -- a
    // repeated id updates its existing entry in place rather than moving to the end (`Map.set`'s
    // own semantics).
    let mut outstanding: Vec<(String, String)> = Vec::new();

    for line in &lines {
        let Some(parsed) = parse_tail_line(line) else {
            continue;
        };
        match parsed {
            TailLine::SessionExit {
                reason,
                pending_tool_calls,
            } => {
                // This life's own exit record and its own evidence -- never inherit an EARLIER
                // life's still-outstanding calls into it (those were this record's business, and
                // this record already carries its own `pendingToolCalls`).
                exit_record = Some(ExitRecord {
                    reason,
                    pending_tool_calls,
                });
                outstanding.clear();
            }
            TailLine::Assistant { tool_calls } => {
                // An assistant turn after an exit record means that crash was resumed and
                // superseded -- no longer the TRAILING entry this detector cares about.
                exit_record = None;
                for (id, name) in tool_calls {
                    if let Some(entry) =
                        outstanding.iter_mut().find(|(existing, _)| existing == &id)
                    {
                        entry.1 = name;
                    } else {
                        outstanding.push((id, name));
                    }
                }
            }
            TailLine::ToolResult { tool_call_id } => {
                exit_record = None;
                outstanding.retain(|(id, _)| id != &tool_call_id);
            }
            TailLine::User => {
                // A new user prompt cannot follow an unanswered tool call within one healthy
                // process life -- an earlier life's orphaned call is judged on its own, never
                // carried into this one (quality-gate fix, `terminationDetection.ts` cycle 2).
                exit_record = None;
                outstanding.clear();
            }
            TailLine::Other => {}
        }
    }

    let pending_tool_names: Vec<String> = outstanding.into_iter().map(|(_, name)| name).collect();

    if let Some(exit) = exit_record {
        let reason_value = exit.reason.unwrap_or_else(|| "unknown".to_string());
        let record_pending = exit.pending_tool_calls.unwrap_or(pending_tool_names);
        if reason_value == "dispose" {
            return TerminationDetectionResult::clean();
        }
        return TerminationDetectionResult {
            terminated_unexpectedly: true,
            pending_tool_names: record_pending,
        };
    }

    if !pending_tool_names.is_empty() {
        return TerminationDetectionResult {
            terminated_unexpectedly: true,
            pending_tool_names,
        };
    }

    TerminationDetectionResult::clean()
}

struct CacheEntry {
    size: u64,
    mtime_ms: i64,
    result: TerminationDetectionResult,
}

/// Caches by `(file, size, mtimeMs)`: an unrelated Session's status refresh costs a cheap `stat`
/// instead of a repeat 256 KiB read for a Conversation that has not changed since the last call.
/// Simplification from the TS port (which caches the in-flight `Promise` itself, de-duplicating
/// two concurrent calls for the very same unchanged file): this caches the completed `result`
/// only, so two calls racing before either finishes both read the file once each -- a minor
/// perf-only difference, never a correctness one.
static CACHE: LazyLock<StdMutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Issue #510 slice 1: the sole entry point. `file` absent (no Conversation has ever been
/// started) is always clean with no file access attempted.
pub(crate) async fn detect_unexpected_termination(
    file: Option<&str>,
) -> TerminationDetectionResult {
    let Some(file) = file else {
        return TerminationDetectionResult::clean();
    };
    let metadata = match tokio::fs::metadata(file).await {
        Ok(metadata) => metadata,
        Err(_) => {
            CACHE
                .lock()
                .expect("termination cache mutex poisoned")
                .remove(file);
            return TerminationDetectionResult::clean();
        }
    };
    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    {
        let cache = CACHE.lock().expect("termination cache mutex poisoned");
        if let Some(entry) = cache.get(file) {
            if entry.size == size && entry.mtime_ms == mtime_ms {
                return entry.result.clone();
            }
        }
    }
    let result = compute_detection(file).await;
    {
        let mut cache = CACHE.lock().expect("termination cache mutex poisoned");
        // Perf gate-fix: one entry per distinct Conversation path ever seen this run would grow
        // unbounded across a very long-lived process with many archived Sessions. A real desktop
        // user's own Session count stays small (realistically dozens, not thousands), so a
        // coarse "clear everything past this bound" is enough -- the next call for any
        // still-relevant file just re-populates its own entry, same cost as a cold cache.
        const CACHE_MAX_ENTRIES: usize = 500;
        if cache.len() >= CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(
            file.to_string(),
            CacheEntry {
                size,
                mtime_ms,
                result: result.clone(),
            },
        );
    }
    result
}

// ---------------------------------------------------------------------------------------------
// Persisted stopped-on-request marker (port of `stoppedOnRequestMarker.ts`)
// ---------------------------------------------------------------------------------------------

/// Writes the marker for `conversation` at the moment of a requested stop (`on_exit`'s requested
/// branch, below). Stats the file for its exact size rather than trusting any in-memory byte
/// count. A missing/unreadable Conversation (the agent stopped before its first turn) sets no
/// marker. Never fails the caller: a write failure here must not crash the exit handler it runs
/// from.
async fn record_stopped_on_request_marker(agent: &SessionAgent, conversation: Option<&str>) {
    let Some(conversation) = conversation else {
        return;
    };
    let Ok(metadata) = tokio::fs::metadata(conversation).await else {
        return;
    };
    let patch = SessionPatch {
        stopped_on_request_conversation: Some(Some(conversation.to_string())),
        stopped_on_request_at_size: Some(Some(metadata.len() as i64)),
        ..Default::default()
    };
    let _ = agent
        .registry()
        .lock()
        .await
        .update_session(agent.session_id(), patch)
        .await;
}

/// True only when `session` carries a marker for its OWN current Conversation whose recorded
/// size still matches that file's real size on disk right now. Any mismatch returns `false`:
/// judge the tail fresh, exactly as if no marker had ever existed. Never panics.
async fn is_stopped_on_request_marker_valid(session: &Session) -> bool {
    let Some(current) = &session.current_conversation else {
        return false;
    };
    let Some(marker_conversation) = &session.stopped_on_request_conversation else {
        return false;
    };
    if marker_conversation != current {
        return false;
    }
    let Some(marker_size) = session.stopped_on_request_at_size else {
        return false;
    };
    if marker_size < 0 {
        return false;
    }
    match tokio::fs::metadata(current).await {
        Ok(metadata) => metadata.len() == marker_size as u64,
        Err(_) => false,
    }
}

/// Port of `resolveTermination`: the "requested stop (in-memory flag or a valid persisted
/// marker) -> clean, else read the tail" rule every call site routes through. `pub(super)`
/// (lane R3, issue #786, gate-fix): `session::manager`'s own `summaries()` calls this directly
/// for a Session with no LIVE agent this run (nothing to call `resolve_termination()`'s own
/// `SessionAgent` method through).
pub(super) async fn resolve_termination_for(
    session: &Session,
    stopped_on_request: bool,
) -> TerminationDetectionResult {
    if stopped_on_request || is_stopped_on_request_marker_valid(session).await {
        return TerminationDetectionResult::clean();
    }
    detect_unexpected_termination(session.current_conversation.as_deref()).await
}

impl SessionAgent {
    /// `sessions.open`/`.recover`/`.resume` (`ipc::sessions_agent`): a FRESH read each call,
    /// never trusting a cached flag from an earlier `on_exit` this run -- a Session that crashed
    /// in a PREVIOUS run has no live `on_exit` to have computed anything yet.
    pub(crate) async fn resolve_termination(&self) -> TerminationDetectionResult {
        let Some(session) = self
            .registry()
            .lock()
            .await
            .get_session(self.session_id())
            .cloned()
        else {
            return TerminationDetectionResult::clean();
        };
        let stopped_on_request = self.with_termination_state(|s| s.stopped_on_request).await;
        resolve_termination_for(&session, stopped_on_request).await
    }

    /// Called at the top of every `launch()` attempt (`agent::launch`'s own "one hook"): a new
    /// life starting means whatever the PREVIOUS life's requested stop protected no longer
    /// applies to THIS one.
    pub(super) async fn clear_stopped_on_request_marker(&self) {
        self.with_termination_state(|s| {
            s.stopped_on_request = false;
            // Gate-fix: a new life starting means whatever the PREVIOUS life's crash banner
            // showed no longer applies either -- `on_exit` will recompute a fresh verdict for
            // THIS life if it too ends unexpectedly, but until then nothing is wrong.
            s.terminated_unexpectedly = false;
            s.pending_tool_names.clear();
        })
        .await;
        let Some(session) = self
            .registry()
            .lock()
            .await
            .get_session(self.session_id())
            .cloned()
        else {
            return;
        };
        // Perf gate-fix: every `launch()` attempt calls this, the overwhelming majority with no
        // marker set at all (a fresh Session, or one that last stopped on a genuine crash, never
        // a requested stop) -- skip the registry write (and the event it would broadcast)
        // entirely rather than pay it on every single start for nothing to actually clear.
        if session.stopped_on_request_conversation.is_none()
            && session.stopped_on_request_at_size.is_none()
        {
            return;
        }
        let patch = SessionPatch {
            stopped_on_request_conversation: Some(None),
            stopped_on_request_at_size: Some(None),
            ..Default::default()
        };
        let _ = self
            .registry()
            .lock()
            .await
            .update_session(self.session_id(), patch)
            .await;
    }
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op: termination is judged from the Conversation file tail at exit time, not from any
    // live frame.
}

/// Port of `SessionAgent.onExit`'s requested/crash branches (issue #510's own
/// `detectUnexpectedTermination`/`stoppedOnRequestMarker` consultation), kept here rather than in
/// `agent/frame.rs`'s own `handle_exit` per this lane's extension-point contract. Runs AFTER
/// `agent::frame`'s own `handle_exit` has already set `status`/`stopReason` and emitted once;
/// this computes the (possibly file-read-bound) termination verdict and re-emits so the crash
/// banner appears without the renderer needing to re-open the Session. `agent::frame`'s own
/// dispatch gates this call on `is_current` (never invoked for a stale exit belonging to an
/// already-superseded life).
///
/// `stop_requested` (the Session's OWN flag, set only by `shutdown()`), NOT the raw
/// `ProcessEvent::Exit`'s own `requested` (gate-fix, TS cycle-6: the process-level `requested`
/// flag is ALSO true for `launch()`'s own internal cleanup stop and for `watch_for_cancel`'s
/// cancel-triggered `proc.stop()` -- neither is a genuine user-requested stop, and wrongly
/// recording a stopped-on-request marker for either would mask a real problem as a clean exit).
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, stop_requested: bool) {
    let session = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned();
    if stop_requested {
        agent
            .with_termination_state(|s| {
                s.stopped_on_request = true;
                s.terminated_unexpectedly = false;
                s.pending_tool_names.clear();
            })
            .await;
        if let Some(session) = &session {
            record_stopped_on_request_marker(agent, session.current_conversation.as_deref()).await;
        }
    } else {
        agent
            .with_termination_state(|s| s.stopped_on_request = false)
            .await;
        let file = session
            .as_ref()
            .and_then(|s| s.current_conversation.clone());
        let result = detect_unexpected_termination(file.as_deref()).await;
        agent
            .with_termination_state(|s| {
                s.terminated_unexpectedly = result.terminated_unexpectedly;
                s.pending_tool_names = result.pending_tool_names.clone();
            })
            .await;
    }
    agent.emit_status().await;
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

#[cfg(test)]
#[path = "termination.test.rs"]
mod tests;
