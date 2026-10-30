// Progress/jobs application and synthetic-stream helpers for `session::subagents`, split out to
// keep that file under the 600-line cap.

use std::time::Duration;

use serde_json::{json, Value};

use super::super::agent::SessionAgent;
use super::{State, SummaryStatus};

/// Coalesces `subagent:patch` on the same window as `readout`'s transcript patches.
const PATCH_COALESCE_MS: u64 = 50;

/// Caps the synthetic stream so a long-running subagent cannot grow without limit.
/// The `stream_ids` dedupe set is not capped: OMP can re-report an evicted id.
const MAX_STREAM_ROWS: usize = 500;

/// Maps OMP's progress status to a terminal or running `SubagentStatus`.
/// Any terminal word settles the entry; `pending`/`running`/absent stays running.
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
    // Unrecognised terminal words count as success.
    SummaryStatus::Finished
}

/// Applies per-index progress from a `task` call's batch, matched by id then by position.
/// `force_terminal` only settles entries that have no matching progress entry at all.
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
                // Duration updates are stored but do not emit a broadcast by themselves.
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

/// Settles a running summary with no `progress[]` entry, matched by label. A missing status
/// on arrival counts as done.
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

/// Asks OMP to push subagent lifecycle frames. Best effort; older OMP just answers `success:false`.
pub(super) async fn subscribe_to_subagent_frames(agent: &SessionAgent) {
    // Fire-and-forget so attach and reset never block on the RPC timeout.
    let agent = agent.arc();
    tokio::spawn(async move {
        if let Err(err) = agent
            .request_rpc(
                json!({ "type": "set_subagent_subscription", "level": "progress" }),
                10_000,
            )
            .await
        {
            log::debug!("subagent subscription not established: {}", err.code);
        }
    });
}

/// Applies one standalone lifecycle or progress frame, matched by `(parentToolCallId, index)`.
/// Only a running entry moves, so a late frame never rewrites a settled status.
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
            let (changed, ops) = (|| {
                let Some(target) = s
                    .summaries
                    .iter()
                    .position(|e| e.tool_call_id == parent && u64::from(e.spec_index) == index)
                else {
                    return (false, Vec::new());
                };
                let mut changed = false;
                let entry = &mut s.summaries[target];
                if detached && !entry.background {
                    entry.background = true;
                    changed = true;
                }
                if entry.status != SummaryStatus::Running {
                    return (changed, Vec::new());
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
                    return (changed, Vec::new());
                }
                let Some(progress) = payload.get("progress") else {
                    return (changed, Vec::new());
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
                (changed, ops)
            })();
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

/// Reads `recentOutput` defensively; the populated element shape is not yet confirmed live.
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

/// Appends progress rows in place and returns only the new rows, so the caller never clones the stream.
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
    // The evicted row's id stays in `ids` so a re-reported id is still deduped.
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
                // Row header for the Agents card.
                if let Some(name) = &e.name {
                    obj.as_object_mut()
                        .expect("summary entry serialises to a JSON object")
                        .insert("name".to_string(), json!(name));
                }
                // One-line summary for the Agents hover card.
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

/// A hidden Session computes its subagent list but never pushes it live.
pub(super) async fn emit_subagents_update(agent: &SessionAgent, value: Value) {
    if !agent.is_visible() {
        return;
    }
    agent
        .events()
        .emit_subagents_update(agent.session_id(), value);
}

/// Coalesces subagent patch ops to one emit per `PATCH_COALESCE_MS`, and never emits for a hidden Session.
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
