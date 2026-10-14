// Subagent tracking built on OMP's own per-call frames (`get_subagents`/#712, #489) (lane R5,
// issue #788). Pre-declared so lane R5 is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// Port of `src/main/omp/subagentStream.ts` (`applySubagentProgress`) plus the subagent-tracking
// half of `SessionAgent.ts` (`handleTaskStart`/`handleTaskUpdate`/`handleTaskEnd`) and the
// authoritative-completion half of `transcript.ts` (`mapProgressStatus`/`applyAsyncResultJobs`,
// FINDINGS item 22(e)).
//
// Round 2 (code review + test review + performance gate, round 1): the status mapping now
// settles every terminal status OMP actually sends (not only `"completed"`), the `task` call's
// own END frame (`tool_execution_end`'s `result.details.progress`) is read the same way an
// update frame is -- applying whatever REAL per-index status it carries, never Electron's own
// blanket "every still-running becomes Finished/Failed" safety net (issue #712's actual bug: a
// background/async `task` call's end frame arrives the moment the batch is spawned, long before
// its subagents are genuinely done, so a blanket override there is exactly the bug, but reading
// the SAME frame's own real per-index progress is not -- it only ever applies a status OMP
// itself reported for that index, same as an update frame would) -- and ANY `tool_execution_end`'s
// `result.details.jobs[]` (the `wait` tool's own completion carrier, `transcript.ts`'s own
// `jobsFromDetails`/`applyAsyncResultJobs`, matched here by `label === name_or_task` since this
// build does not track a separate `job_id`) settles a `Running` entry with no `progress` match at
// all. `on_exit` now settles every `Running` entry to `Exited` immediately (not only on the next
// `launch()`), so a crash or a deliberate stop clears the pill without waiting for a reattach.
//
// Not implemented this round (disclosed, see the PR body and FINDINGS.md item 58, a live probe
// against the real signed-in `omp 18.10.1`, 2026-10-14): `get_subagents` is confirmed real but
// cannot help a reattach (a fresh process's own registry is always empty, even onto the SAME
// Conversation a prior process's genuinely-running subagent used), so this file correctly never
// calls it. `set_subagent_subscription({level:"progress"})` is confirmed real and, once active,
// OMP pushes STANDALONE top-level `subagent_lifecycle`/`subagent_progress` frames -- a stronger,
// proactive background-completion channel than the `wait`-tool `jobs[]` path `apply_jobs` already
// uses, needing no explicit `wait()` call at all -- but this build does not subscribe, so it never
// receives them; adopting that channel is a concrete next step for a follow-up round, not done
// here. `on_attach_reconcile` adds the "No live output" notice for an empty stream (Electron gate
// finding 6) but still does not re-derive historical finished/failed candidates from the
// reattached transcript's own `subagent` rows the way TS's fuller version does (Electron gate
// finding 4, a persisted `currentTurnSubagents` durable-turn-marker concept this build has no
// equivalent of).
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
//
// Split round 2 (issue #806, 600-line cap): the progress/jobs application and synthetic-stream
// helpers live in the sibling `subagents_progress.rs` (`map_progress_status`,
// `apply_progress_to_batch`, `apply_jobs`, `apply_subagent_progress_in_place`, and the small
// `tool_item_id`/`tool_args_preview`/`output_text`/`summaries_to_value`/`emit_subagents_update`/
// `queue_patch_ops` helpers they share) -- this file keeps the data model, the lane hooks, the
// public IPC-facing entry points, and `handle_task_start`.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

#[path = "subagents_progress.rs"]
mod subagents_progress;
use subagents_progress::{
    apply_jobs, apply_progress_to_batch, emit_subagents_update, queue_patch_ops, summaries_to_value,
};

const NAME_OR_TASK_MAX_CHARS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SummaryStatus {
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
pub(super) struct SummaryEntry {
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
    /// Performance gate round 1: one `HashSet` of row ids per stream, kept alongside `streams`
    /// so a new `recentTools`/`recentOutput` entry's "already rendered?" check is O(1) instead of
    /// a linear scan of the (ever-growing) stream vec itself.
    stream_ids: HashMap<String, HashSet<String>>,
    /// `chat.setVisibleSubagent`'s own selection: `None` = panel closed / nothing selected, so
    /// no `subagent:patch` is ever forwarded.
    visible_id: Option<String>,
    /// Performance gate round 1 (coalescing): ops accumulated for the CURRENTLY visible subagent
    /// since the last flush, and whether a flush timer is already pending.
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
        // Issue #712 (the real fix, not the bug): the `task` call's OWN end frame still applies
        // whatever REAL per-index status its `result.details.progress` carries (exactly like an
        // update frame) -- it never force-overrides an index with no matching entry, so a
        // background batch whose subagents are still genuinely running is untouched here.
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
            // `transcript.ts`'s own `jobsFromDetails`/`applyAsyncResultJobs`: the `wait` tool's
            // own end frame is the other real carrier of per-subagent completion, checked on
            // EVERY tool_execution_end regardless of the calling tool's name.
            if let Some(jobs) = frame
                .get("result")
                .and_then(|r| r.get("details"))
                .and_then(|d| d.get("jobs"))
                .and_then(Value::as_array)
            {
                apply_jobs(agent, jobs).await;
            }
        }
        _ => {}
    }
}

/// Settles every `Running` summary to `Exited` immediately (not only on the next `launch()`'s own
/// `on_attach_reconcile`): a crash or a deliberate stop must clear the pill right away, matching
/// the CRITICAL gate finding ("in on_exit, settle Running to exited"). Gate round 2 (code HIGH):
/// this is a plain process exit, not a reattach, so `seed_notice: false` -- a crash/stop never
/// claims "Refract reattached" (that claim is only ever true from `on_attach_reconcile`'s own
/// call site, below).
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    settle_running_to_exited(agent, false).await;
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

/// Settles every `Running` summary to `Exited` (gate finding ("in on_exit, settle Running to
/// exited"). `seed_notice` is true ONLY from `on_attach_reconcile`'s own call site (Electron gate
/// finding 6): a summary with no live stream at all when it settles there gets a one-row "No live
/// output" notice, port of `reconcileSubagentsOnAttach`'s own placeholder -- `on_exit`'s own call
/// (a plain process exit, not a reattach) passes `false` so a crash/stop never claims "Refract
/// reattached" when nothing reattached at all (gate round 2, code MEDIUM). Scoped to exactly the
/// `Running`->`Exited` transition this function performs; a summary that was already
/// `Finished`/`Failed` before this call is untouched, and this does not re-derive historical
/// candidates from the reattached transcript's own `subagent` rows the way TS's fuller version
/// does (Electron gate finding 4, still disclosed as not ported -- see the PR body). Also
/// schedules a readout update when anything changed (gate round 2, code HIGH): otherwise the
/// chip can keep reading "1 running" after a crash/stop with no turn left to trigger a recompute.
/// If the settled, notice-seeded subagent is the CURRENTLY visible one (gate round 2, code
/// MEDIUM), the notice is also queued as a `subagent:patch` upsert -- replacing `streams` alone
/// never reaches an already-open panel, which only ever learns of new rows through that patch
/// channel.
async fn settle_running_to_exited(agent: &SessionAgent, seed_notice: bool) {
    let (summaries_value, visible_ops) = agent
        .with_subagents_state(|s| {
            let mut changed = false;
            let mut settled_ids = Vec::new();
            for entry in &mut s.summaries {
                if entry.status == SummaryStatus::Running {
                    entry.status = SummaryStatus::Exited;
                    changed = true;
                    settled_ids.push(entry.id.clone());
                }
            }
            let mut visible_ops = Vec::new();
            if seed_notice {
                for id in settled_ids {
                    let is_empty = s.streams.get(&id).map(|rows| rows.is_empty()).unwrap_or(true);
                    if is_empty {
                        let notice = json!({
                            "kind": "notice",
                            "id": format!("{id}:reattach-notice"),
                            "level": "info",
                            "text": "No live output: this subagent had already exited when Refract reattached.",
                        });
                        s.streams.insert(id.clone(), vec![notice.clone()]);
                        s.stream_ids.insert(id.clone(), HashSet::new());
                        if s.visible_id.as_deref() == Some(id.as_str()) {
                            visible_ops.push(json!({ "op": "upsert", "item": notice }));
                        }
                    }
                }
            }
            (changed.then(|| summaries_to_value(&s.summaries)), visible_ops)
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

/// `session::agent::launch`'s own hook (see this file's own header), called once per `launch()`
/// attempt, right before `sync_from_state`. Simplified from `reconcileSubagentsOnAttach` (issue
/// #489): resolves every summary THIS `SessionAgent` instance still remembers as `Running` to
/// `Exited` (a fresh `OmpProcess` is about to attach -- or just did -- and has no way to confirm
/// the old one's in-flight work survived it), covering the common "Resume/Recover after a crash,
/// same app run" case, and seeds the "No live output" notice for any of those with no stream
/// (Electron gate finding 6, via `settle_running_to_exited(agent, true)`). Does NOT re-derive
/// historical finished/failed candidates from the reattached transcript's own `subagent` rows
/// the way TS's fuller version does (Electron gate finding 4) -- disclosed simplification, see
/// the PR body's own "Open problems".
pub(super) async fn on_attach_reconcile(agent: &SessionAgent) {
    settle_running_to_exited(agent, true).await;
}

/// `conversations.rs`'s own hook (issue #577): the previous Conversation's subagents (and their
/// streams/selection) never belong to the brand-new or just-switched-to one. Also schedules a
/// readout update (code-review finding, round 1): the chip's own `subagentCount` must not keep
/// showing the old Conversation's count if this clear is the only thing that changed.
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
}

/// Performance gate round 1 (memory growth): at every `agent_start`, drops the (potentially
/// large) stream content of every subagent that has both settled (not `Running`) AND is not the
/// currently visible one -- `summaries` themselves are kept (the panel/pill still needs their
/// final status), only the heavy per-row stream data is freed. A long Conversation's finished
/// batches therefore cost a small, bounded summary row each, never an ever-growing stream.
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

/// `chat.setVisibleSubagent` (`ipc::subagents`): selects which subagent's live stream is
/// forwarded as `subagent:patch`.
pub async fn set_visible(agent: &SessionAgent, subagent_id: Option<String>) {
    agent
        .with_subagents_state(|s| {
            s.visible_id = subagent_id;
            s.pending_patch_ops.clear();
        })
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

/// Code-review round 1: `ipc::conversations::build_snapshot`'s own one-line hook, the
/// `SubagentSummary[]` counterpart to `readout::current_readout_value` -- the live list instead
/// of the permanent empty seed, so a Session switch/split/resume shows running agents straight
/// away (matches `util.ts`'s own `agent.runtimeSnapshot.subagents` seed).
pub async fn current_summaries_value(agent: &SessionAgent) -> Value {
    agent
        .with_subagents_state(|s| summaries_to_value(&s.summaries))
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
                s.stream_ids.entry(entry.id.clone()).or_default();
            }
            s.summaries.extend(created);
            summaries_to_value(&s.summaries)
        })
        .await;
    emit_subagents_update(agent, summaries_value).await;
    super::readout::schedule_readout_update(agent).await;
}
