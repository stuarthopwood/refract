// Subagent tracking built on OMP's own per-call frames (`get_subagents`/#712, #489) (lane R5,
// issue #788). Pre-declared so lane R5 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// Port of `src/main/omp/subagentStream.ts` (`applySubagentProgress`) plus the subagent-tracking
// half of `SessionAgent.ts` (`handleTaskStart`/`handleTaskUpdate`) -- deliberately NOT
// `handleTaskEnd`'s own "safety net" (see below) and NOT the full `reconcileSubagentsOnAttach`
// (a simplified, disclosed subset, see `on_attach_reconcile`'s own doc comment).
//
// Issue #712 (the actual fix this lane builds, not the bug): Electron's `handleTaskEnd` marks
// every still-`running` subagent of an ENDING `task` call `finished`/`failed` as a "safety net" --
// correct for a SYNCHRONOUS `task` call (which blocks until every subagent truly finishes, so by
// the time its own `tool_execution_end` arrives, the last `tool_execution_update` has already
// reported the real terminal status), but WRONG for an ASYNC/background `task` call: OMP's own
// docs say that call returns (and so fires `tool_execution_end`) the moment the batch is
// *spawned*, while the subagents keep running in the background -- Electron's safety net then
// stamps them "finished" within moments of starting, while they are still working (issue #712's
// own bug report). This Rust port never force-settles on a `tool_execution_end` at all: status
// comes ONLY from each `tool_execution_update`'s own `progress[].status` field (which keeps
// streaming for a background batch too, per OMP's own docs), so a background subagent stays
// `running` for as long as OMP itself reports it is. The list also, deliberately, does NOT clear
// at the next `agent_start` the way Electron's turn-scoped `runtime.subagents` does (issue #712's
// "the pill stays visible while any agent runs, across turns"): it is cleared only by
// `on_conversation_reset` (issue #577) or settled to `Exited` by `on_attach_reconcile` (issue
// #489) when the OMP process itself is recycled.
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane R5 adds its subagent behaviour inside these
// functions, never inside any file under `session/agent/`.
//
// Two small core hooks this lane adds (issue #784, "if you truly need a core change, keep it to
// one line"), mirroring `session::readout`'s own: `session::agent::launch`'s own `launch()` calls
// `on_attach_reconcile` right before its own `sync_from_state` call (the same point TS's
// `reconcileSubagentsOnAttach()` runs); `conversations.rs`'s `start_new_conversation`/
// `open_conversation` each call `on_conversation_reset` before their own `sync_from_state` call.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

const NAME_OR_TASK_MAX_CHARS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SummaryStatus {
    Running,
    Finished,
    Failed,
    Exited,
}

impl SummaryStatus {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Exited => "exited",
        }
    }
}

#[derive(Debug, Clone)]
struct SummaryEntry {
    id: String,
    tool_call_id: String,
    spec_index: u32,
    name_or_task: String,
    status: SummaryStatus,
    started_at: i64,
    duration_ms: Option<i64>,
}

/// Lane R5's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_subagents_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    /// Current subagents (issue #712: persists across turns). Correlated by `(tool_call_id,
    /// spec_index)` internally; the public `id` is `${toolCallId}:${nameOrTask}`, disambiguated
    /// with a `:${occurrence}` suffix within one batch when two specs share a name.
    summaries: Vec<SummaryEntry>,
    /// Per-subagent live stream (`recentTools[]`/`recentOutput[]` diffed into synthetic
    /// `TranscriptItem`-shaped rows), keyed by summary id. The `chat.subagentSnapshot` source and
    /// the `subagent:patch` diff base for whichever id is currently `visible_id`.
    streams: HashMap<String, Vec<Value>>,
    /// `chat.setVisibleSubagent`'s own selection: `None` = panel closed / nothing selected, so
    /// no `subagent:patch` is ever forwarded.
    visible_id: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    match frame_type {
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
            handle_task_update(agent, frame).await;
        }
        // Deliberately no `tool_execution_end` arm: see this file's own header for why
        // Electron's "mark running finished at call end" safety net is not ported.
        _ => {}
    }
}

pub(super) async fn on_exit(_agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // No-op: a process exit is handled the same way a restart is, through `on_attach_reconcile`
    // the NEXT time `launch()` runs (Resume/Recover), never here -- matches TS, which only ever
    // resolves a stale `running` summary on the next attach, never at the exit itself.
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

/// `session::agent::launch`'s own hook (see this file's own header), called once per `launch()`
/// attempt, right before `sync_from_state`. Simplified from `reconcileSubagentsOnAttach` (issue
/// #489): resolves every summary THIS `SessionAgent` instance still remembers as `Running` to
/// `Exited` (a fresh `OmpProcess` is about to attach -- or just did -- and has no way to confirm
/// the old one's in-flight work survived it), covering the common "Resume/Recover after a crash,
/// same app run" case. Does NOT re-derive historical finished/failed candidates from the
/// reattached transcript's own `subagent` rows the way TS's fuller version does (a disclosed
/// simplification for a full APP restart, where this `SessionAgent` instance itself is brand new
/// and so starts with an empty list regardless -- see the PR body's own "Open problems").
pub(super) async fn on_attach_reconcile(agent: &SessionAgent) {
    let summaries_value = agent
        .with_subagents_state(|s| {
            let mut changed = false;
            for entry in &mut s.summaries {
                if entry.status == SummaryStatus::Running {
                    entry.status = SummaryStatus::Exited;
                    changed = true;
                }
            }
            changed.then(|| summaries_to_value(&s.summaries))
        })
        .await;
    if let Some(value) = summaries_value {
        agent
            .events()
            .emit_subagents_update(agent.session_id(), value);
    }
}

/// `conversations.rs`'s own hook (issue #577): the previous Conversation's subagents (and their
/// streams/selection) never belong to the brand-new or just-switched-to one.
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    let had_any = agent
        .with_subagents_state(|s| {
            let had = !s.summaries.is_empty();
            s.summaries.clear();
            s.streams.clear();
            s.visible_id = None;
            had
        })
        .await;
    if had_any {
        agent
            .events()
            .emit_subagents_update(agent.session_id(), Value::Array(Vec::new()));
    }
}

/// `chat.setVisibleSubagent` (`ipc::subagents`): selects which subagent's live stream is
/// forwarded as `subagent:patch`.
pub async fn set_visible(agent: &SessionAgent, subagent_id: Option<String>) {
    agent
        .with_subagents_state(|s| s.visible_id = subagent_id)
        .await;
}

/// `chat.subagentSnapshot` (`ipc::subagents`): the full current stream for one subagent, or
/// `None` when `subagent_id` does not match a current `SubagentSummary` (the channel's own
/// `not-found` error, per `src/shared/ipc.ts`'s doc comment).
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

/// `session::readout`'s own cross-lane read for `SessionReadout.subagentCount` (spec 004
/// FR-007): running/finished/exited/failed counts over the CURRENT list, or `None` when there
/// are none at all (hides the chip).
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
            for entry in &s.summaries {
                match entry.status {
                    SummaryStatus::Running => running += 1,
                    SummaryStatus::Finished => finished += 1,
                    SummaryStatus::Exited => exited += 1,
                    SummaryStatus::Failed => failed += 1,
                }
            }
            Some(json!({
                "running": running,
                "finished": finished,
                "exited": exited,
                "failed": failed,
            }))
        })
        .await
}

/// `args.tasks[]` entries, read the same defensive way `transcript.ts`'s `readTaskSpecs` does.
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

/// `tool_execution_start` for the `task` tool: creates one `SubagentSummary` per spec (port of
/// `handleTaskStart`, minus the persisted `currentTurnSubagents` durable-turn marker -- this
/// build never clears the list at the next turn start, so that marker's own purpose, telling
/// "this turn's" subagents apart from an earlier one's, does not apply here).
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
            status: SummaryStatus::Running,
            started_at,
            duration_ms: None,
        });
    }

    let summaries_value = agent
        .with_subagents_state(|s| {
            for entry in &created {
                s.streams.entry(entry.id.clone()).or_default();
            }
            s.summaries.extend(created);
            summaries_to_value(&s.summaries)
        })
        .await;
    agent
        .events()
        .emit_subagents_update(agent.session_id(), summaries_value);
    super::readout::schedule_readout_update(agent).await;
}

fn map_progress_status(status: &str) -> SummaryStatus {
    if status == "completed" {
        return SummaryStatus::Finished;
    }
    let lower = status.to_lowercase();
    if lower.contains("failed") || lower.contains("cancelled") || lower.contains("error") {
        return SummaryStatus::Failed;
    }
    SummaryStatus::Running
}

/// `tool_execution_update` for the `task` tool (port of `handleTaskUpdate`): scoped first to
/// only this call's own batch (`tool_call_id`), then correlated by `progress[].id` within that
/// batch, falling back to position when no id match is found -- identical to TS's own
/// disambiguation (see `handle_task_start`'s own occurrence suffix, the reason a bare id match
/// can legitimately miss for a duplicate-named batch).
async fn handle_task_update(agent: &SessionAgent, frame: &Value) {
    let Some(progress_list) = frame
        .get("partialResult")
        .and_then(|p| p.get("details"))
        .and_then(|d| d.get("progress"))
        .and_then(Value::as_array)
    else {
        return;
    };
    if progress_list.is_empty() {
        return;
    }
    let tool_call_id = frame
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("");

    let (summaries_value, visible_patch) = agent
        .with_subagents_state(|s| {
            let batch_indices: Vec<usize> = s
                .summaries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.tool_call_id == tool_call_id)
                .map(|(i, _)| i)
                .collect();
            if batch_indices.is_empty() {
                return (None, None);
            }
            let mut changed = false;
            let mut visible_patch: Option<(String, usize, Vec<Value>)> = None;
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
                if new_duration.is_some() && entry.duration_ms != new_duration {
                    entry.duration_ms = new_duration;
                    changed = true;
                }

                let stream_id = entry.id.clone();
                let is_visible = s.visible_id.as_deref() == Some(stream_id.as_str());
                let current_stream = s.streams.get(&stream_id).cloned().unwrap_or_default();
                let next_stream = apply_subagent_progress(&current_stream, &stream_id, progress);
                if next_stream.len() != current_stream.len() {
                    if is_visible {
                        visible_patch =
                            Some((stream_id.clone(), current_stream.len(), next_stream.clone()));
                    }
                    s.streams.insert(stream_id, next_stream);
                }
            }
            let summaries_value = changed.then(|| summaries_to_value(&s.summaries));
            (summaries_value, visible_patch)
        })
        .await;

    if let Some(value) = summaries_value {
        agent
            .events()
            .emit_subagents_update(agent.session_id(), value);
    }
    if let Some((stream_id, previous_len, next)) = visible_patch {
        let ops = diff_stream(previous_len, &next);
        agent
            .events()
            .emit_subagent_patch(agent.session_id(), &stream_id, json!(ops));
    }
    super::readout::schedule_readout_update(agent).await;
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

/// Port of `applySubagentProgress`: upserts a synthetic `tool`-kind row per new `recentTools[]`
/// entry and an `assistant-text`-kind row per new `recentOutput[]` entry, both keyed by a stable
/// id so a call already rendered is never duplicated as the window grows. Only ever APPENDS
/// (never mutates an existing row), so `diff_stream` below can diff by length alone.
fn apply_subagent_progress(items: &[Value], subagent_id: &str, progress: &Value) -> Vec<Value> {
    let mut next = items.to_vec();
    if let Some(recent_tools) = progress.get("recentTools").and_then(Value::as_array) {
        for entry in recent_tools {
            let tool = entry.get("tool").and_then(Value::as_str).unwrap_or("");
            let end_ms = entry.get("endMs").and_then(Value::as_i64).unwrap_or(0);
            let id = tool_item_id(subagent_id, tool, end_ms);
            if next
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                continue;
            }
            let is_error = entry
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            next.push(json!({
                "kind": "tool",
                "id": id,
                "toolCallId": id,
                "tool": tool,
                "target": tool_args_preview(entry),
                "status": if is_error { "error" } else { "done" },
                "args": entry.get("args").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    if let Some(recent_output) = progress.get("recentOutput").and_then(Value::as_array) {
        for (index, entry) in recent_output.iter().enumerate() {
            let id = format!("subagent-output:{subagent_id}:{index}");
            if next
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                continue;
            }
            let Some(text) = output_text(entry) else {
                continue;
            };
            next.push(
                json!({ "kind": "assistant-text", "id": id, "text": text, "streaming": false }),
            );
        }
    }
    next
}

/// `subagent:patch`'s own `TranscriptOp[]`: every row past `previous_len` is a brand-new upsert
/// (`apply_subagent_progress` only ever appends, never mutates in place).
fn diff_stream(previous_len: usize, next: &[Value]) -> Vec<Value> {
    next[previous_len..]
        .iter()
        .map(|item| json!({ "op": "upsert", "item": item }))
        .collect()
}

fn summaries_to_value(summaries: &[SummaryEntry]) -> Value {
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
                obj
            })
            .collect(),
    )
}
