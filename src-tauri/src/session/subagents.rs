// Subagent tracking from OMP's per-call and `subagent_*` frames.
// A `task` end frame applies only real per-index statuses, since blanket overrides break async batches.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

#[path = "subagents_progress.rs"]
mod subagents_progress;
use subagents_progress::{
    apply_jobs, apply_progress_to_batch, apply_subagent_frame, emit_subagents_update,
    queue_patch_ops, subscribe_to_subagent_frames, summaries_to_value,
};

const NAME_OR_TASK_MAX_CHARS: usize = 60;
/// Task-summary budget, separate from `NAME_OR_TASK_MAX_CHARS` (#700/#701).
const TASK_SUMMARY_MAX_CHARS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SummaryStatus {
    Running,
    Finished,
    Failed,
    /// Split from `Failed`: a cancelled subagent did nothing wrong (#563).
    Cancelled,
    Exited,
}

impl SummaryStatus {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Exited => "exited",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct SummaryEntry {
    id: String,
    tool_call_id: String,
    spec_index: u32,
    name_or_task: String,
    /// Subagent's given `name`; `None` falls back to `nameOrTask` on the card.
    name: Option<String>,
    /// One-line summary for the Agents card, independent of `name`.
    task_summary: Option<String>,
    status: SummaryStatus,
    started_at: i64,
    duration_ms: Option<i64>,
    /// #712: OMP reported `detached: true` (an async background job).
    background: bool,
}

/// Subagent runtime state held inside `AgentState`, reached via `with_subagents_state`.
#[derive(Default)]
pub(super) struct State {
    /// Keyed by `(tool_call_id, spec_index)`; the public `id` gets a suffix on duplicate names.
    summaries: Vec<SummaryEntry>,
    /// Live stream rows per summary id.
    streams: HashMap<String, Vec<Value>>,
    /// Row ids per stream so the "already rendered?" check is O(1), not a vec scan.
    stream_ids: HashMap<String, HashSet<String>>,
    /// `None` = panel closed, so no `subagent:patch` is forwarded.
    visible_id: Option<String>,
    /// Coalesced patch ops for the visible subagent since the last flush.
    pending_patch_ops: Vec<Value>,
    patch_timer_pending: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    match frame_type {
        "agent_start" => prune_finished_streams(agent).await,
        "tool_execution_start" => {
            if frame.get("toolName").and_then(Value::as_str) == Some("task") {
                let tool_call_id = frame
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = frame.get("args").cloned().unwrap_or(Value::Null);
                handle_task_start(agent, &tool_call_id, &args).await;
            }
        }
        "tool_execution_update"
            if frame.get("toolName").and_then(Value::as_str) == Some("task") =>
        {
            let tool_call_id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(progress) = frame
                .get("partialResult")
                .and_then(|p| p.get("details"))
                .and_then(|d| d.get("progress"))
                .and_then(Value::as_array)
            {
                apply_progress_to_batch(agent, &tool_call_id, progress, false).await;
            }
        }
        // Only real per-index statuses apply here; a background batch is still running.
        "tool_execution_end" => {
            let tool_call_id = frame
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if frame.get("toolName").and_then(Value::as_str) == Some("task") {
                if let Some(progress) = frame
                    .get("result")
                    .and_then(|r| r.get("details"))
                    .and_then(|d| d.get("progress"))
                    .and_then(Value::as_array)
                {
                    apply_progress_to_batch(agent, &tool_call_id, progress, true).await;
                }
            }
            // The `wait` tool's end frame also carries completions, so check every end frame.
            if let Some(jobs) = frame
                .get("result")
                .and_then(|r| r.get("details"))
                .and_then(|d| d.get("jobs"))
                .and_then(Value::as_array)
            {
                apply_jobs(agent, jobs).await;
            }
        }
        "subagent_lifecycle" | "subagent_progress" => {
            if let Some(payload) = frame.get("payload") {
                apply_subagent_frame(agent, frame_type, payload).await;
            }
        }
        _ => {}
    }
}

/// Settles `Running` summaries on exit: `Cancelled` for a requested stop, else `Exited`.
pub(super) async fn on_exit(
    agent: &SessionAgent,
    _code: Option<i32>,
    requested: bool,
    stop_requested: bool,
) {
    let target = if requested && stop_requested {
        SummaryStatus::Cancelled
    } else {
        SummaryStatus::Exited
    };
    settle_running_subagents(
        agent,
        target,
        "No live output: this subagent was still running when the agent process stopped.",
    )
    .await;
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner belongs to `session::start_queue`.
}

/// Settles `Running` summaries to `target_status`, queueing a patch so an open panel sees it.
async fn settle_running_subagents(
    agent: &SessionAgent,
    target_status: SummaryStatus,
    notice_text: &str,
) {
    let (summaries_value, visible_ops) = agent
        .with_subagents_state(|s| {
            let mut changed = false;
            let mut settled_ids = Vec::new();
            for entry in &mut s.summaries {
                if entry.status == SummaryStatus::Running {
                    entry.status = target_status;
                    changed = true;
                    settled_ids.push(entry.id.clone());
                }
            }
            let mut visible_ops = Vec::new();
            for id in settled_ids {
                let is_empty = s
                    .streams
                    .get(&id)
                    .map(|rows| rows.is_empty())
                    .unwrap_or(true);
                if is_empty {
                    let notice = json!({
                        "kind": "notice",
                        "id": format!("{id}:reattach-notice"),
                        "level": "info",
                        "text": notice_text,
                    });
                    s.streams.insert(id.clone(), vec![notice.clone()]);
                    s.stream_ids.insert(id.clone(), HashSet::new());
                    if s.visible_id.as_deref() == Some(id.as_str()) {
                        visible_ops.push(json!({ "op": "upsert", "item": notice }));
                    }
                }
            }
            (
                changed.then(|| summaries_to_value(&s.summaries)),
                visible_ops,
            )
        })
        .await;
    if !visible_ops.is_empty() {
        queue_patch_ops(agent, visible_ops).await;
    }
    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
        super::readout::schedule_readout_update(agent).await;
    }
}

/// Launch hook: settles stale `Running` summaries to `Exited`; a new process can't confirm them.
pub(super) async fn on_attach_reconcile(agent: &SessionAgent) {
    settle_running_subagents(
        agent,
        SummaryStatus::Exited,
        "No live output: this subagent had already exited when Refract reattached.",
    )
    .await;
    subscribe_to_subagent_frames(agent).await;
}

/// Conversation hook: clears the previous Conversation's subagents (#577).
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    let had_any = agent
        .with_subagents_state(|s| {
            let had = !s.summaries.is_empty();
            s.summaries.clear();
            s.streams.clear();
            s.stream_ids.clear();
            s.visible_id = None;
            s.pending_patch_ops.clear();
            had
        })
        .await;
    if had_any {
        emit_subagents_update(agent, Value::Array(Vec::new())).await;
    }
    super::readout::schedule_readout_update(agent).await;
    subscribe_to_subagent_frames(agent).await;
}

/// At `agent_start`, frees streams of settled, non-visible subagents to bound memory.
async fn prune_finished_streams(agent: &SessionAgent) {
    agent
        .with_subagents_state(|s| {
            let visible = s.visible_id.clone();
            let droppable: Vec<String> = s
                .summaries
                .iter()
                .filter(|e| e.status != SummaryStatus::Running && Some(&e.id) != visible.as_ref())
                .map(|e| e.id.clone())
                .collect();
            for id in droppable {
                s.streams.remove(&id);
                s.stream_ids.remove(&id);
            }
        })
        .await;
}

/// Selects which subagent's live stream is forwarded as `subagent:patch`.
pub async fn set_visible(agent: &SessionAgent, subagent_id: Option<String>) {
    agent
        .with_subagents_state(|s| {
            s.visible_id = subagent_id;
            s.pending_patch_ops.clear();
        })
        .await;
}

/// Full current stream for one subagent, or `None` when the id is unknown (`not-found`).
pub async fn snapshot(agent: &SessionAgent, subagent_id: &str) -> Option<Vec<Value>> {
    agent
        .with_subagents_state(|s| {
            if !s.summaries.iter().any(|e| e.id == subagent_id) {
                return None;
            }
            Some(s.streams.get(subagent_id).cloned().unwrap_or_default())
        })
        .await
}

/// Live `SubagentSummary[]` for conversation snapshots, so a switch/resume shows running agents.
pub async fn current_summaries_value(agent: &SessionAgent) -> Value {
    agent
        .with_subagents_state(|s| summaries_to_value(&s.summaries))
        .await
}

/// Counts for `SessionReadout.subagentCount`; `None` hides the chip.
pub(super) async fn subagent_count(agent: &SessionAgent) -> Option<Value> {
    agent
        .with_subagents_state(|s| {
            if s.summaries.is_empty() {
                return None;
            }
            let mut running = 0u32;
            let mut finished = 0u32;
            let mut exited = 0u32;
            let mut failed = 0u32;
            let mut cancelled = 0u32;
            for entry in &s.summaries {
                match entry.status {
                    SummaryStatus::Running => running += 1,
                    SummaryStatus::Finished => finished += 1,
                    SummaryStatus::Exited => exited += 1,
                    SummaryStatus::Failed => failed += 1,
                    SummaryStatus::Cancelled => cancelled += 1,
                }
            }
            Some(json!({
                "running": running,
                "finished": finished,
                "exited": exited,
                "failed": failed,
                "cancelled": cancelled,
            }))
        })
        .await
}

/// `args.tasks[]` entries, read defensively.
fn read_task_specs(args: &Value) -> Vec<Value> {
    args.get("tasks")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|t| t.is_object()).cloned().collect())
        .unwrap_or_default()
}

fn subagent_name_or_task(spec: &Value) -> String {
    if let Some(name) = spec.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let task = spec.get("task").and_then(Value::as_str).unwrap_or("");
    if task.is_empty() {
        return "Subagent".to_string();
    }
    let chars: Vec<char> = task.chars().collect();
    if chars.len() > NAME_OR_TASK_MAX_CHARS {
        let truncated: String = chars[..NAME_OR_TASK_MAX_CHARS].iter().collect();
        format!("{truncated}...")
    } else {
        task.to_string()
    }
}

/// Subagent's given `name`; `None` when empty or absent.
fn subagent_name(spec: &Value) -> Option<String> {
    spec.get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// One-line task summary: first sentence, capped at 100 chars. `None` when empty.
fn subagent_task_summary(spec: &Value) -> Option<String> {
    let raw = spec.get("task").and_then(Value::as_str).unwrap_or("");
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let without_heading = if collapsed.starts_with('#') {
        collapsed.trim_start_matches('#').trim_start()
    } else {
        collapsed.as_str()
    };
    if without_heading.is_empty() {
        return None;
    }
    let mut sentence_end = None;
    for (i, c) in without_heading.char_indices() {
        if c != '.' && c != '!' && c != '?' {
            continue;
        }
        let after = i + c.len_utf8();
        if without_heading[after..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
        {
            sentence_end = Some(after);
            break;
        }
    }
    let sentence = sentence_end
        .map_or(without_heading, |end| &without_heading[..end])
        .trim();
    if sentence.is_empty() {
        return None;
    }
    let char_count = sentence.chars().count();
    if char_count > TASK_SUMMARY_MAX_CHARS {
        let keep = TASK_SUMMARY_MAX_CHARS.saturating_sub(3);
        let byte_end = sentence
            .char_indices()
            .nth(keep)
            .map_or(sentence.len(), |(i, _)| i);
        let truncated = sentence[..byte_end].trim_end();
        Some(format!("{truncated}..."))
    } else {
        Some(sentence.to_string())
    }
}

/// `tool_execution_start` for `task`: creates one `SubagentSummary` per spec.
async fn handle_task_start(agent: &SessionAgent, tool_call_id: &str, args: &Value) {
    let specs = read_task_specs(args);
    if specs.is_empty() {
        return;
    }
    let started_at = now_ms();
    let base_ids: Vec<String> = specs
        .iter()
        .map(|spec| format!("{tool_call_id}:{}", subagent_name_or_task(spec)))
        .collect();
    let mut base_id_counts: HashMap<&str, u32> = HashMap::new();
    for base_id in &base_ids {
        *base_id_counts.entry(base_id.as_str()).or_insert(0) += 1;
    }
    let mut occurrence_index: HashMap<&str, u32> = HashMap::new();
    let mut created = Vec::with_capacity(specs.len());
    for (index, spec) in specs.iter().enumerate() {
        let base_id = base_ids[index].as_str();
        let occurrence = *occurrence_index.get(base_id).unwrap_or(&0);
        occurrence_index.insert(base_id, occurrence + 1);
        let id = if *base_id_counts.get(base_id).unwrap_or(&0) > 1 {
            format!("{base_id}:{occurrence}")
        } else {
            base_id.to_string()
        };
        created.push(SummaryEntry {
            id,
            tool_call_id: tool_call_id.to_string(),
            spec_index: index as u32,
            name_or_task: subagent_name_or_task(spec),
            name: subagent_name(spec),
            task_summary: subagent_task_summary(spec),
            status: SummaryStatus::Running,
            started_at,
            duration_ms: None,
            background: false,
        });
    }

    let summaries_value = agent
        .with_subagents_state(|s| {
            for entry in &created {
                s.streams.entry(entry.id.clone()).or_default();
                s.stream_ids.entry(entry.id.clone()).or_default();
            }
            s.summaries.extend(created);
            summaries_to_value(&s.summaries)
        })
        .await;
    emit_subagents_update(agent, summaries_value).await;
    super::readout::schedule_readout_update(agent).await;
}
