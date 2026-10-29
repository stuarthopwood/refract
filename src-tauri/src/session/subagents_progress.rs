// Progress/jobs application and synthetic-stream helpers for `session::subagents` (lane R5,
// issue #788), split out of that file (issue #806, 600-line cap) the same way
// `session::termination`'s own `termination_detection.rs` splits out its tail-read logic.
// Pre-declared/owned by lane R5 exactly like its parent file.

use std::time::Duration;

use serde_json::{json, Value};

use super::super::agent::SessionAgent;
use super::{State, SummaryStatus};

/// Performance gate round 1: matches `readout`'s own coalesce window so `subagent:patch` is
/// coalesced the same way `transcript:patch`'s `PatchCoalescer` is -- a bespoke debounce here
/// rather than reusing that struct directly, since it is generic over `TranscriptItem`/
/// `Arc<TranscriptItem>`, not the plain `serde_json::Value` rows this module's own synthetic
/// stream uses.
const PATCH_COALESCE_MS: u64 = 50;

/// Gate round 2 (security/perf LOW): Electron's `subagentStream.ts` has no cap of its own to
/// mirror, so this is a new, deliberately generous bound -- a very long-running or chatty
/// subagent must not grow its own synthetic CONTENT stream without limit for the lifetime of
/// the Conversation. Oldest rows are dropped first; the visible subagent's own `subagent:patch`
/// stream only ever diffs forward from here anyway, so an already-open panel never sees a row
/// vanish out from under it mid-view. Follow-up fix (#788): the `stream_ids` dedupe set itself
/// is deliberately NOT capped alongside it -- OMP can re-report an id it already sent, and an
/// evicted-but-forgotten id would churn straight back into the stream and immediately
/// re-trigger its own eviction; a dedupe set's own small string ids cost far less memory than
/// the full content rows they stand for.
const MAX_STREAM_ROWS: usize = 500;

/// Port of `transcript.ts`'s own `mapProgressStatus`, extended to settle a `SubagentSummary`
/// (not just a chat-row `running|done|error`): every terminal status OMP sends (`"completed"`,
/// `"finished"`, `"failed"`, `"cancelled"`, `"error"`, `"aborted"`, ...) maps to `Finished`/
/// `Failed`/`Cancelled`; `"pending"`/`"running"`/absent stays `Running`. Critical gate fix
/// (round 1): the previous version only ever recognised the literal string `"completed"` as
/// terminal, so a real `omp`'s own `"finished"` (confirmed by
/// `scripts/fixtures/omp-frames/subagents.jsonl`, written against the documented wire contract)
/// was read as still-running forever. Issue #563 decision 15: `"cancelled"`/`"aborted"` used to
/// fold into `Failed` -- split into their own `Cancelled` status, since neither means the
/// subagent's own work went wrong.
fn map_progress_status(status: &str) -> SummaryStatus {
    let lower = status.to_lowercase();
    if lower.contains("cancel") || lower.contains("abort") {
        return SummaryStatus::Cancelled;
    }
    if lower.contains("fail") || lower.contains("error") {
        return SummaryStatus::Failed;
    }
    if matches!(
        lower.as_str(),
        "pending" | "running" | "started" | "queued" | "spawned" | ""
    ) {
        return SummaryStatus::Running;
    }
    // "completed", "finished", "done", or anything else OMP might send that isn't one of the
    // recognised in-flight/failure/cancellation words above: a terminal, successful status.
    SummaryStatus::Finished
}

/// Shared by `tool_execution_update` (`force_terminal: false`) and the `task` call's own
/// `tool_execution_end` (`force_terminal: true`, see the parent file's own header for why reading
/// the END frame's real per-index progress is not the same bug as Electron's blanket override):
/// scoped first to only this call's own batch (`tool_call_id`), then correlated by `progress[].id`
/// within that batch, falling back to position when no id match is found -- identical to TS's own
/// disambiguation (see `handle_task_start`'s own occurrence suffix, the reason a bare id match can
/// legitimately miss for a duplicate-named batch). `force_terminal` only affects entries that have
/// NO matching progress entry at all: when the end frame's own progress array is simply shorter
/// than the batch (a subagent OMP stopped reporting on), that entry has nothing here to settle it
/// -- `apply_jobs`/`on_exit` are what eventually resolve it, never a blanket mark here.
pub(super) async fn apply_progress_to_batch(
    agent: &SessionAgent,
    tool_call_id: &str,
    progress_list: &[Value],
    _force_terminal: bool,
) {
    if progress_list.is_empty() {
        return;
    }
    let (summaries_value, visible_ops) = agent
        .with_subagents_state(|s| {
            let batch_indices: Vec<usize> = s
                .summaries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.tool_call_id == tool_call_id)
                .map(|(i, _)| i)
                .collect();
            if batch_indices.is_empty() {
                return (None, Vec::new());
            }
            let mut changed = false;
            let mut visible_ops: Vec<Value> = Vec::new();
            for (i, progress) in progress_list.iter().enumerate() {
                let progress_id = progress.get("id").and_then(Value::as_str).unwrap_or("");
                let composite_id = format!("{tool_call_id}:{progress_id}");
                let target_index = batch_indices
                    .iter()
                    .copied()
                    .find(|&idx| s.summaries[idx].id == composite_id)
                    .or_else(|| batch_indices.get(i).copied());
                let Some(target_index) = target_index else {
                    continue;
                };
                let status_str = progress.get("status").and_then(Value::as_str).unwrap_or("");
                let new_status = map_progress_status(status_str);
                let new_duration = progress
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .filter(|d| *d > 0);
                let entry = &mut s.summaries[target_index];
                if entry.status != new_status {
                    entry.status = new_status;
                    changed = true;
                }
                // Gate round 2 (perf MEDIUM): `durationMs` ticks up on nearly every live
                // `tool_execution_update` while still running -- storing it is cheap and keeps
                // the data fresh, but it must not by itself trigger a full `subagents:update`
                // broadcast on every single tick; only a genuine status move (already handled
                // above) or the FINAL duration once the entry leaves `Running` counts as a
                // visible change here.
                if new_duration.is_some() && entry.duration_ms != new_duration {
                    entry.duration_ms = new_duration;
                    if new_status != SummaryStatus::Running {
                        changed = true;
                    }
                }

                let stream_id = entry.id.clone();
                let is_visible = s.visible_id.as_deref() == Some(stream_id.as_str());
                let new_rows = apply_subagent_progress_in_place(s, &stream_id, progress);
                if is_visible {
                    visible_ops.extend(
                        new_rows
                            .into_iter()
                            .map(|item| json!({ "op": "upsert", "item": item })),
                    );
                }
            }
            let summaries_value = changed.then(|| summaries_to_value(&s.summaries));
            (summaries_value, visible_ops)
        })
        .await;

    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
    }
    if !visible_ops.is_empty() {
        queue_patch_ops(agent, visible_ops).await;
    }
    super::super::readout::schedule_readout_update(agent).await;
}

/// `transcript.ts`'s own `jobsFromDetails`/`applyAsyncResultJobs`: settles a `Running` summary
/// that has NO matching `progress[]` entry at all, correlated here by `label === name_or_task`
/// (this build does not track a separate `job_id`, a disclosed simplification -- see the PR body).
/// `"pending"`/`"running"` job statuses are not terminal; arrival with no `status` field at all is
/// read as done, matching `applyAsyncResultJobs`'s own "arrival itself is read as done" rule.
pub(super) async fn apply_jobs(agent: &SessionAgent, jobs: &[Value]) {
    let summaries_value = agent
        .with_subagents_state(|s| {
            let mut changed = false;
            for entry in &mut s.summaries {
                if entry.status != SummaryStatus::Running {
                    continue;
                }
                let Some(job) = jobs.iter().find(|j| {
                    j.get("label").and_then(Value::as_str) == Some(entry.name_or_task.as_str())
                }) else {
                    continue;
                };
                let status_str = job.get("status").and_then(Value::as_str);
                if matches!(status_str, Some("pending") | Some("running")) {
                    continue;
                }
                entry.status = match status_str {
                    Some(s) => map_progress_status(s),
                    None => SummaryStatus::Finished,
                };
                changed = true;
                if let Some(d) = job.get("durationMs").and_then(Value::as_i64) {
                    if d > 0 {
                        entry.duration_ms = Some(d);
                    }
                }
            }
            changed.then(|| summaries_to_value(&s.summaries))
        })
        .await;
    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
    }
    super::super::readout::schedule_readout_update(agent).await;
}

/// Issue #712: asks OMP (default level `off`) to push `subagent_lifecycle`/`subagent_progress`
/// frames for every subagent, including detached background jobs. Best effort: an older OMP
/// without the command just answers `success:false`, leaving `apply_jobs`/`on_exit` as the
/// settle paths.
pub(super) async fn subscribe_to_subagent_frames(agent: &SessionAgent) {
    let _ = agent
        .request_rpc(
            json!({ "type": "set_subagent_subscription", "level": "progress" }),
            10_000,
        )
        .await;
}

/// Issue #712: applies one standalone `subagent_lifecycle`/`subagent_progress` payload, matched to
/// a summary by `(parentToolCallId, index)`. Only a `Running` entry moves, so a late frame never
/// rewrites an already-settled status. The lifecycle frame carries no duration, so a settled
/// entry keeps the larger of the last progress `durationMs` and the time Refract observed.
pub(super) async fn apply_subagent_frame(agent: &SessionAgent, frame_type: &str, payload: &Value) {
    let Some(parent) = payload.get("parentToolCallId").and_then(Value::as_str) else {
        return;
    };
    let Some(index) = payload.get("index").and_then(Value::as_u64) else {
        return;
    };
    let detached = payload.get("detached").and_then(Value::as_bool) == Some(true);
    let is_lifecycle = frame_type == "subagent_lifecycle";
    let (summaries_value, visible_ops) = agent
        .with_subagents_state(|s| {
            let Some(target) = s
                .summaries
                .iter()
                .position(|e| e.tool_call_id == parent && u64::from(e.spec_index) == index)
            else {
                return (None, Vec::new());
            };
            let mut changed = false;
            let entry = &mut s.summaries[target];
            if detached && !entry.background {
                entry.background = true;
                changed = true;
            }
            if entry.status != SummaryStatus::Running {
                return (
                    changed.then(|| summaries_to_value(&s.summaries)),
                    Vec::new(),
                );
            }
            if is_lifecycle {
                let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
                let new_status = map_progress_status(status);
                if new_status != SummaryStatus::Running {
                    let observed = super::now_ms() - entry.started_at;
                    entry.status = new_status;
                    entry.duration_ms = Some(entry.duration_ms.unwrap_or(0).max(observed));
                    changed = true;
                }
                return (
                    changed.then(|| summaries_to_value(&s.summaries)),
                    Vec::new(),
                );
            }
            let Some(progress) = payload.get("progress") else {
                return (
                    changed.then(|| summaries_to_value(&s.summaries)),
                    Vec::new(),
                );
            };
            if let Some(d) = progress.get("durationMs").and_then(Value::as_i64) {
                if d > 0 {
                    entry.duration_ms = Some(d);
                }
            }
            let stream_id = entry.id.clone();
            let is_visible = s.visible_id.as_deref() == Some(stream_id.as_str());
            let new_rows = apply_subagent_progress_in_place(s, &stream_id, progress);
            let ops = if is_visible {
                new_rows
                    .into_iter()
                    .map(|item| json!({ "op": "upsert", "item": item }))
                    .collect()
            } else {
                Vec::new()
            };
            (changed.then(|| summaries_to_value(&s.summaries)), ops)
        })
        .await;
    let settled = summaries_value.is_some();
    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
    }
    if !visible_ops.is_empty() {
        queue_patch_ops(agent, visible_ops).await;
    }
    if settled {
        super::super::readout::schedule_readout_update(agent).await;
    }
}

fn tool_item_id(subagent_id: &str, tool: &str, end_ms: i64) -> String {
    format!("subagent-tool:{subagent_id}:{end_ms}:{tool}")
}

fn tool_args_preview(entry: &Value) -> String {
    if let Some(args) = entry.get("args").and_then(Value::as_str) {
        return args.to_string();
    }
    entry
        .get("intent")
        .and_then(Value::as_str)
        .or_else(|| entry.get("tool").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// `recentOutput[]`'s populated element shape was never observed live (FINDINGS item 36): read
/// defensively -- a plain string, or a common `{text}`/`{content}` wrapper; anything else is
/// skipped rather than guessed at.
fn output_text(entry: &Value) -> Option<String> {
    if let Some(s) = entry.as_str() {
        return Some(s.to_string());
    }
    if entry.is_object() {
        if let Some(t) = entry.get("text").and_then(Value::as_str) {
            return Some(t.to_string());
        }
        if let Some(c) = entry.get("content").and_then(Value::as_str) {
            return Some(c.to_string());
        }
    }
    None
}

/// Port of `applySubagentProgress`, rewritten to mutate `state.streams`/`state.stream_ids` IN
/// PLACE (performance gate round 1): the previous version cloned the whole stream twice per
/// update (once to read it, once via `items.to_vec()` inside the old free function) regardless of
/// whether anything new had arrived, and deduped by a linear scan of the ever-growing vec.
/// Returns only the newly-appended rows (never the whole stream), which is also exactly what a
/// visible subagent's own `subagent:patch` diff needs -- no separate "diff by length" pass.
fn apply_subagent_progress_in_place(
    state: &mut State,
    subagent_id: &str,
    progress: &Value,
) -> Vec<Value> {
    let mut new_rows = Vec::new();
    let stream = state.streams.entry(subagent_id.to_string()).or_default();
    let ids = state.stream_ids.entry(subagent_id.to_string()).or_default();
    if let Some(recent_tools) = progress.get("recentTools").and_then(Value::as_array) {
        for entry in recent_tools {
            let tool = entry.get("tool").and_then(Value::as_str).unwrap_or("");
            let end_ms = entry.get("endMs").and_then(Value::as_i64).unwrap_or(0);
            let id = tool_item_id(subagent_id, tool, end_ms);
            if !ids.insert(id.clone()) {
                continue; // already rendered
            }
            let is_error = entry
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let row = json!({
                "kind": "tool",
                "id": id,
                "toolCallId": id,
                "tool": tool,
                "target": tool_args_preview(entry),
                "status": if is_error { "error" } else { "done" },
                "args": entry.get("args").cloned().unwrap_or(Value::Null),
            });
            stream.push(row.clone());
            new_rows.push(row);
        }
    }
    if let Some(recent_output) = progress.get("recentOutput").and_then(Value::as_array) {
        for (index, entry) in recent_output.iter().enumerate() {
            let id = format!("subagent-output:{subagent_id}:{index}");
            if !ids.insert(id.clone()) {
                continue;
            }
            let Some(text) = output_text(entry) else {
                continue;
            };
            let row =
                json!({ "kind": "assistant-text", "id": id, "text": text, "streaming": false });
            stream.push(row.clone());
            new_rows.push(row);
        }
    }
    // Follow-up fix (#788): the evicted row's own id must STAY in `ids` -- OMP's own
    // `recentTools`/`recentOutput` can re-report an id it already sent once before (the
    // existing "already rendered" dedupe above relies on this), so removing it here let an
    // evicted-then-re-reported id churn back into the stream, immediately re-triggering its own
    // eviction next time -- only the CONTENT row is dropped to bound memory; the dedupe
    // membership itself is permanent for the life of this subagent's stream.
    if stream.len() > MAX_STREAM_ROWS {
        let overflow = stream.len() - MAX_STREAM_ROWS;
        stream.drain(0..overflow);
    }
    new_rows
}

pub(super) fn summaries_to_value(summaries: &[super::SummaryEntry]) -> Value {
    Value::Array(
        summaries
            .iter()
            .map(|e| {
                let mut obj = json!({
                    "id": e.id,
                    "toolCallId": e.tool_call_id,
                    "specIndex": e.spec_index,
                    "nameOrTask": e.name_or_task,
                    "status": e.status.as_wire(),
                    "startedAt": e.started_at,
                });
                if let Some(duration) = e.duration_ms {
                    obj.as_object_mut()
                        .expect("summary entry serialises to a JSON object")
                        .insert("durationMs".to_string(), json!(duration));
                }
                // Gate round 1 fix 6 (#700/#701 slice b): the Agents card's own row header.
                if let Some(name) = &e.name {
                    obj.as_object_mut()
                        .expect("summary entry serialises to a JSON object")
                        .insert("name".to_string(), json!(name));
                }
                // Issue #700/#701 slice (b): the Agents hover-focus card's own one-line summary.
                if let Some(task_summary) = &e.task_summary {
                    obj.as_object_mut()
                        .expect("summary entry serialises to a JSON object")
                        .insert("taskSummary".to_string(), json!(task_summary));
                }
                if e.background {
                    obj.as_object_mut()
                        .expect("summary entry serialises to a JSON object")
                        .insert("background".to_string(), json!(true));
                }
                obj
            })
            .collect(),
    )
}

/// Code-review round 1: `subagents:update` follows `transcript:patch`'s own visibility rule --
/// a hidden Session's subagent list keeps computing (so it is correct the instant it becomes
/// visible, carried by the `sessions.open`/`.recover` snapshot) but is never pushed live while
/// hidden.
pub(super) async fn emit_subagents_update(agent: &SessionAgent, value: Value) {
    if !agent.is_visible() {
        return;
    }
    agent
        .events()
        .emit_subagents_update(agent.session_id(), value);
}

/// Performance gate round 1 ("one `subagent:patch` per update frame with no coalescing"):
/// accumulates ops and debounces the actual emit to at most one per `PATCH_COALESCE_MS`, the same
/// window `PatchCoalescer` uses for `transcript:patch`. Also gates on visibility (code-review
/// round 1): queuing still happens unconditionally (cheap, just a `Vec` push), but nothing is EVER
/// sent for a hidden Session -- `set_visible` already clears `pending_patch_ops` the instant a
/// different subagent (or none) is selected, so a hidden Session never accumulates ops for a
/// subagent nobody is looking at either.
pub(super) async fn queue_patch_ops(agent: &SessionAgent, ops: Vec<Value>) {
    let should_spawn = agent
        .with_subagents_state(|s| {
            s.pending_patch_ops.extend(ops);
            if s.patch_timer_pending {
                false
            } else {
                s.patch_timer_pending = true;
                true
            }
        })
        .await;
    if !should_spawn {
        return;
    }
    let agent = agent.arc();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PATCH_COALESCE_MS)).await;
        let (ops, visible_id) = agent
            .with_subagents_state(|s| {
                s.patch_timer_pending = false;
                let ops = std::mem::take(&mut s.pending_patch_ops);
                let visible_id = s.visible_id.clone();
                (ops, visible_id)
            })
            .await;
        if ops.is_empty() || !agent.is_visible() {
            return;
        }
        let Some(subagent_id) = visible_id else {
            return;
        };
        agent
            .events()
            .emit_subagent_patch(agent.session_id(), &subagent_id, json!(ops));
    });
}
