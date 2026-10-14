// Tail-only crash detection (port of `terminationDetection.ts`), split out of `termination.rs`
// (code review finding, round 4, 2026-10-14: pushed `termination.rs` to 631 lines, past issue
// #806's 600-line soft cap). No behaviour change: every item moved here verbatim (`clean()`
// calls become the equivalent `TerminationDetectionResult::default()` since that private helper
// stayed in `termination.rs` with the struct it belongs to). `detect_unexpected_termination` is
// re-exported from `termination.rs` so every existing caller's `termination::
// detect_unexpected_termination` path is unchanged. See `termination.rs`'s own header for this
// lane's full scope and the `on_frame`/`on_exit`/`on_start_progress` extension-point contract.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::TerminationDetectionResult;

/// Never read more than this many bytes from the tail of a Conversation file on the first pass
/// (issue #510: "no whole-file read"). Mirrors `terminationDetection.ts`'s own `TAIL_BYTES`.
const TAIL_BYTES: u64 = 256 * 1024;
/// Mirrors `terminationDetection.ts`'s own `MAX_TAIL_BYTES`: the doubling cap for the
/// single-oversized-line case.
const MAX_TAIL_BYTES: u64 = TAIL_BYTES * 8;

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
            return TerminationDetectionResult::default();
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

    TerminationDetectionResult::default()
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
        return TerminationDetectionResult::default();
    };
    let metadata = match tokio::fs::metadata(file).await {
        Ok(metadata) => metadata,
        Err(_) => {
            CACHE
                .lock()
                .expect("termination cache mutex poisoned")
                .remove(file);
            return TerminationDetectionResult::default();
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
