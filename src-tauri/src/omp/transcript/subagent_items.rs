// Port of `src/main/omp/transcript.ts` lines 110-278 (T078, FINDINGS item 22(e)): builds and
// updates `subagent` `TranscriptItem`s from a batch `task()` call's live frames and history
// `toolResult`/`async-result` messages. Split out of the parent `transcript` module (#899 gate
// round 2) so `transcript.rs` stays at its 2083-line file-size baseline while this module picks
// up the `message_id` stamp (gate round 2 architect addendum A, #563): Stage membership keys on
// the owning assistant message's id, not on timing, since reopened history carries no subagent
// timing at all (`transcript.rs`'s own `from_history` stamps `h{index}` message ids, already a
// stable per-message ordinal; a live message id orders the same way, just not numerically).

use std::sync::Arc;

use serde_json::Value;

use super::{
    now_ms, SubagentStatus, TranscriptItem, ASYNC_RESULT_CUSTOM_TYPE, SUBAGENT_NAME_LENGTH,
};

/// Reads `args.tasks[]` defensively (port of `readTaskSpecs`): a malformed or absent array means
/// the caller falls back to rendering the call as a plain `tool` item instead of silently
/// dropping it.
pub(super) fn read_task_specs(args: &Value) -> Vec<Value> {
    args.get("tasks")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|t| t.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// Reads the batch call's own shared `context` argument (sibling of `tasks[]` on the wire,
/// `omp/tools/task.md`'s batch schema `{ context, tasks[] }`): the Stage's batch brief, whose
/// first line names the Stage (issue #941). `None` for a flat (non-batch) call or a malformed/
/// missing string.
pub(super) fn read_batch_context(args: &Value) -> Option<String> {
    args.get("context")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(super) fn task_text(spec: &Value) -> String {
    spec.get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(super) fn subagent_name(spec: &Value) -> String {
    if let Some(name) = spec.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let task = task_text(spec);
    if task.chars().count() > SUBAGENT_NAME_LENGTH {
        format!(
            "{}\u{2026}",
            task.chars().take(SUBAGENT_NAME_LENGTH).collect::<String>()
        )
    } else {
        task
    }
}

/// Upserts one `subagent` item per `specs[]` entry, keyed by `subagent:<tool_call_id>:<index>`.
/// Port of `upsertSubagentItems`. The owning assistant message is not known yet here -- a live
/// `tool_execution_start` frame precedes any message snapshot that echoes the `task` call back
/// as a `toolCall` part -- so `message_id` is stamped empty for now; `build_assistant_items`'s own
/// task branch fills it in moments later once that snapshot arrives, every time it does, so the
/// brief empty window self-corrects rather than needing a second code path.
pub(super) fn upsert_subagent_items(
    mut items: Vec<Arc<TranscriptItem>>,
    tool_call_id: &str,
    specs: &[Value],
    context: Option<&str>,
) -> Vec<Arc<TranscriptItem>> {
    for (index, spec) in specs.iter().enumerate() {
        let id = format!("subagent:{tool_call_id}:{index}");
        let name = subagent_name(spec);
        let task = task_text(spec);
        // Gate round 1 fix (issue #941): `context` is the whole batch call's own shared
        // argument, identical for every spec in `specs[]` -- stored once, on spec index 0
        // only, so it is never duplicated N times across a Stage's own items. The renderer
        // (`groupSubagentStages.ts`) already reads every item's `context` and dedupes/joins,
        // so a `None` here for index > 0 changes nothing it sees.
        let item_context = if index == 0 {
            context.map(str::to_string)
        } else {
            None
        };
        let existing_pos = items.iter().position(|item| item.id() == id);
        match existing_pos {
            Some(pos) => {
                if let TranscriptItem::Subagent {
                    name: n,
                    task: t,
                    context: c,
                    ..
                } = Arc::make_mut(&mut items[pos])
                {
                    *n = name;
                    *t = task;
                    *c = item_context;
                }
            }
            None => items.push(Arc::new(TranscriptItem::Subagent {
                id,
                tool_call_id: tool_call_id.to_string(),
                spec_index: index as u32,
                name,
                task,
                context: item_context,
                status: SubagentStatus::Running,
                started_at: Some(now_ms()),
                duration_ms: None,
                result: None,
                job_id: None,
                message_id: String::new(),
                async_settled: false,
            })),
        }
    }
    items
}

/// `pending`/`running` (still running) are the only statuses FINDINGS item 22(e) actually
/// observed as in-flight; any other string is a plain completion/failure signal. Port of
/// `mapProgressStatus`. Gate round 3 fix (`agent://Main`): `running` used to fall into the
/// `Some(_) => Done` catch-all below, so a spawn-time `progress[i].status: "running"` entry
/// (the repo's own `subagents-background-turn.jsonl` fixture has exactly this shape) was drawn
/// as a quiet Finished check while the agent was still working -- matches
/// `subagents_progress.rs:50`'s own `lower == "pending" || lower == "running"` arm.
fn map_progress_status(status: Option<&str>) -> SubagentStatus {
    match status {
        Some("cancelled") | Some("aborted") => SubagentStatus::Cancelled,
        Some("failed") | Some("error") => SubagentStatus::Error,
        Some("pending") | Some("running") => SubagentStatus::Running,
        None => SubagentStatus::Running,
        Some(_) => SubagentStatus::Done,
    }
}

/// Applies a `task` call's own `tool_execution_end` (live, `live = true`) or `toolResult`
/// (history) result to every `subagent` item sharing `tool_call_id`. Port of
/// `applyBatchTaskResult`. Returns `items` unchanged when `tool_call_id` has no subagent items at
/// all, so callers can fall through to the generic `tool` item path for a malformed `task` call.
pub(super) fn apply_batch_task_result(
    items: Vec<Arc<TranscriptItem>>,
    tool_call_id: &str,
    is_error: bool,
    details: &Value,
    live: bool,
) -> Vec<Arc<TranscriptItem>> {
    let subagent_positions: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            matches!(item.as_ref(), TranscriptItem::Subagent { tool_call_id: t, .. } if t == tool_call_id)
        })
        .map(|(i, _)| i)
        .collect();
    if subagent_positions.is_empty() {
        return items;
    }
    let progress = details.get("progress").and_then(Value::as_array);
    let fallback_status = if is_error {
        SubagentStatus::Error
    } else {
        SubagentStatus::Done
    };
    let mut items = items;
    for (progress_index, &pos) in subagent_positions.iter().enumerate() {
        let entry = progress.and_then(|p| p.get(progress_index));
        if let TranscriptItem::Subagent {
            status,
            job_id,
            duration_ms,
            started_at,
            ..
        } = Arc::make_mut(&mut items[pos])
        {
            let entry_job_id = entry
                .and_then(|e| e.get("id"))
                .and_then(Value::as_str)
                .map(String::from);
            // On a hard batch failure (`is_error`), a row's own `progress[i].status` wins ONLY
            // when it maps to `Cancelled`; anything else -- including a lingering `pending`,
            // which `map_progress_status` reads as still-Running -- falls back to `Error`
            // instead of leaving the row spinning forever once the batch itself has already
            // failed (#899 gate round 2 finding N1, decision 15, #563).
            if is_error {
                let entry_status = entry.and_then(|e| e.get("status")).and_then(Value::as_str);
                *status = match map_progress_status(entry_status) {
                    SubagentStatus::Cancelled => SubagentStatus::Cancelled,
                    _ => fallback_status,
                };
                if let Some(jid) = entry_job_id {
                    *job_id = Some(jid)
                }
                if live {
                    if let Some(sa) = started_at {
                        *duration_ms = Some((now_ms() - *sa).max(0));
                    }
                }
                continue;
            }
            if let Some(entry) = entry {
                let entry_status = entry.get("status").and_then(Value::as_str);
                *status = map_progress_status(entry_status);
                if let Some(jid) = entry_job_id {
                    *job_id = Some(jid);
                }
            } else {
                *status = fallback_status;
                if live {
                    if let Some(sa) = started_at {
                        *duration_ms = Some((now_ms() - *sa).max(0));
                    }
                }
            }
        }
    }
    items
}

fn safe_stringify(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// The authoritative per-subagent completion (FINDINGS item 22(e)): a later `custom`/
/// `async-result` message's `details.jobs[]` keys each entry by `jobId`, the `wait` tool's own
/// `tool_execution_end` by `id` instead -- both key names are matched here, falling back to
/// `label === name` for a subagent that never got a `progress` entry at all. Port of
/// `applyAsyncResultJobs`.
///
/// Issue #989: the `async-result` custom message carries no `tool_call_id` of its own (unlike
/// the richer `parentToolCallId` the subagent_lifecycle/progress/snapshot RPC payloads DO carry,
/// `rpc-wire.schema.json`, #712's not-yet-wired-up subscription path, research.md section 16) --
/// this function only ever sees `details.jobs[]`, where a job's own `id`/`jobId` is just its
/// `label` echoed back verbatim, a FIXTURE-OBSERVED assumption (`job id == label`), not a
/// documented wire guarantee. Reusing that same string across two unrelated Stages running a
/// same-named subagent (fixture `scripts/fixtures/omp-frames/stages-941.jsonl`, "Story559" in
/// Stage 2 then Stage 5) is therefore possible and must not let a later Stage's job clobber an
/// earlier, already-settled Stage's row.
///
/// Gate round 2 (issue #989): the caller (`apply_message_snapshot`, `transcript.rs`) now applies
/// a custom `async-result` message's jobs exactly ONCE, on `message_end` only -- so this
/// function no longer needs to defend against the SAME message landing twice; there is no
/// value-based duplicate check here any more (round 1 had one; it was removed because it could
/// also wrongly no-op a genuinely NEW job that happened to already match a settled row's
/// current status/result/duration).
///
/// A row only becomes **settled** (permanently excluded from matching) once a job carrying REAL
/// data (`resultText`/`errorText`/`schema.data`) resolves it -- a job with none of those (the
/// `wait` tool's bare completion shape, e.g. `subagents-background-turn.jsonl`'s "gamma" job)
/// only ever gets the label-echo fallback below, which never settles a row: a later, genuinely
/// real job sharing that `job_id` still applies.
///
/// Among still-unsettled items, candidates are ranked by THREE tiers, each only a tie-break for
/// the one before it (gate round 2, Code reviewer Q1):
/// 1. a still-**Running** row beats one already ended by its OWN batch result (Error/Cancelled/
///    Done without ever getting a real async result) -- a batch-failed earlier Stage must never
///    beat a later Stage that is still genuinely running;
/// 2. a `job_id` match beats a label-only match (the latter only possible when the item's own
///    `job_id` is still unset) -- when two Stages are BOTH still genuinely running with the SAME
///    label, the one whose `job_id` this job's own `id` already equals is the correct target,
///    even if a later-started Stage also matches by label alone;
/// 3. the latest `started_at` wins any remaining tie.
///
/// Each job claims at most one item per call. Known limit (not fixed here, tracked on #712):
/// two Stages running the SAME name concurrently, both already carrying a `job_id` (so BOTH
/// rank as job_id matches, tier 2 ties), can still swap results -- tier 3's `started_at`
/// tie-break is a best-effort guess, not a real correlation key (there is no `tool_call_id` on
/// this frame to settle it for certain). The real fix is #712's `parentToolCallId`.
pub(super) fn apply_async_result_jobs(
    items: Vec<Arc<TranscriptItem>>,
    jobs: &[Value],
) -> Vec<Arc<TranscriptItem>> {
    let job_id_of = |j: &Value| -> Option<String> {
        j.get("jobId")
            .and_then(Value::as_str)
            .or_else(|| j.get("id").and_then(Value::as_str))
            .map(String::from)
    };

    let mut items = items;
    let mut claimed = vec![false; items.len()];
    for job in jobs {
        let job_status = job.get("status").and_then(Value::as_str);
        if matches!(job_status, Some("pending") | Some("running")) {
            continue;
        }
        let jid = job_id_of(job);
        let label = job.get("label").and_then(Value::as_str);
        // The installed omp 18.5.1 binary's own job records use `'failed'`/`'cancelled'`
        // (direct binary inspection, 2026-10-03), plus `'error'`/`'aborted'`: `'failed'`/
        // `'error'` map to `error`; `'cancelled'`/`'aborted'` get their own `Cancelled`
        // status (decision 15, #563).
        let is_cancelled = matches!(job_status, Some("cancelled") | Some("aborted"));
        let failed = matches!(job_status, Some("failed") | Some("error"));
        let new_status = if is_cancelled {
            SubagentStatus::Cancelled
        } else if failed {
            SubagentStatus::Error
        } else {
            SubagentStatus::Done
        };
        let error_text = job.get("errorText").and_then(Value::as_str);
        let result_text = job.get("resultText").and_then(Value::as_str);
        let schema_data = job.get("schema").and_then(|s| s.get("data"));
        let new_duration = job
            .get("durationMs")
            .and_then(Value::as_f64)
            .map(|f| f as i64);
        let has_real_result = ((failed || is_cancelled) && error_text.is_some())
            || result_text.is_some()
            || schema_data.is_some();

        // Candidate selection, ranked (is_running, matches_job_id, started_at) lexicographically
        // -- tuple comparison already gives exactly the three-tier priority above, the latest
        // `started_at` only ever breaking a tie on both higher tiers.
        let mut best: Option<(bool, bool, i64, usize)> = None;
        for (item_index, item) in items.iter().enumerate() {
            if claimed[item_index] {
                continue;
            }
            let TranscriptItem::Subagent {
                name,
                job_id,
                async_settled,
                status,
                started_at,
                ..
            } = item.as_ref()
            else {
                continue;
            };
            if *async_settled {
                continue;
            }
            let matches_job_id = job_id.is_some() && job_id.as_deref() == jid.as_deref();
            let matches_label = job_id.is_none() && label == Some(name.as_str());
            if !matches_job_id && !matches_label {
                continue;
            }
            let is_running = *status == SubagentStatus::Running;
            let started = started_at.unwrap_or(0);
            let key = (is_running, matches_job_id, started);
            if best.is_none_or(|(b_running, b_job_id, b_started, _)| {
                key >= (b_running, b_job_id, b_started)
            }) {
                best = Some((is_running, matches_job_id, started, item_index));
            }
        }
        let Some((.., item_index)) = best else {
            continue;
        };
        claimed[item_index] = true;

        // `Arc::make_mut` clones the value only when another reference is still outstanding, so
        // a row with no chosen target above never pays a copy.
        if let TranscriptItem::Subagent {
            status,
            duration_ms,
            result,
            job_id,
            async_settled,
            ..
        } = Arc::make_mut(&mut items[item_index])
        {
            let new_result = if (failed || is_cancelled) && error_text.is_some() {
                error_text.map(String::from)
            } else if let Some(r) = result_text {
                Some(r.to_string())
            } else if let Some(data) = schema_data {
                Some(safe_stringify(data))
            } else if let Some(l) = label {
                Some(l.to_string())
            } else {
                result.clone()
            };
            *status = new_status;
            *result = new_result;
            if let Some(d) = new_duration {
                *duration_ms = Some(d);
            }
            if let Some(jid_val) = jid {
                *job_id = Some(jid_val);
            }
            if has_real_result {
                *async_settled = true;
            }
        }
    }
    items
}

/// `details.jobs[]` reader shared by `tool_execution_end`/`toolResult` for the `wait` tool
/// (port of `jobsFromDetails`).
pub(super) fn jobs_from_details(details: &Value) -> Option<Vec<Value>> {
    details.get("jobs").and_then(Value::as_array).cloned()
}

/// Returns the patched items when `message` is a batch-subagent result carrier, `None` when it
/// is not one at all. Port of `tryApplyAsyncResult`.
pub(super) fn try_apply_async_result(
    items: &[Arc<TranscriptItem>],
    custom_type: &str,
    details: &Value,
) -> Option<Vec<Arc<TranscriptItem>>> {
    if custom_type != ASYNC_RESULT_CUSTOM_TYPE {
        return None;
    }
    let jobs = details.get("jobs").and_then(Value::as_array)?;
    Some(apply_async_result_jobs(items.to_vec(), jobs))
}

/// Builds/updates one message's own `subagent` items from its `toolCall` part's echoed `task`
/// call (`build_assistant_items`'s own task branch in the parent `transcript` module): the
/// owning assistant message's id is known HERE (unlike `upsert_subagent_items` above, called
/// from the earlier live `tool_execution_start` frame, before any message snapshot exists), so
/// `message_id` is stamped for real this time. Split out of `transcript.rs` itself (#806
/// file-size discipline, issue #941's own technical note: "`transcript.rs` is over the 600-line
/// cap ... add the parsing in a sibling module").
pub(super) fn build_message_subagent_items(
    existing_items: &[Arc<TranscriptItem>],
    part_id: &str,
    specs: &[Value],
    context: Option<&str>,
    message_id: &str,
    capture_timing: bool,
) -> Vec<TranscriptItem> {
    let mut result = Vec::with_capacity(specs.len());
    for (spec_index, spec) in specs.iter().enumerate() {
        let sub_id = format!("subagent:{part_id}:{spec_index}");
        let sub_name = subagent_name(spec);
        let task = task_text(spec);
        // Gate round 1 fix (issue #941): see `upsert_subagent_items`'s own identical comment --
        // `context` is stored once, on spec index 0 only.
        let item_context = if spec_index == 0 {
            context.map(str::to_string)
        } else {
            None
        };
        let existing = existing_items
            .iter()
            .map(|item| item.as_ref())
            .find(|item| matches!(item, TranscriptItem::Subagent { id, .. } if *id == sub_id));
        match existing {
            Some(TranscriptItem::Subagent {
                id,
                tool_call_id,
                spec_index,
                status,
                started_at,
                duration_ms,
                result: sub_result,
                job_id,
                async_settled,
                ..
            }) => result.push(TranscriptItem::Subagent {
                id: id.clone(),
                tool_call_id: tool_call_id.clone(),
                spec_index: *spec_index,
                name: sub_name,
                task,
                context: item_context,
                status: *status,
                started_at: *started_at,
                duration_ms: *duration_ms,
                result: sub_result.clone(),
                job_id: job_id.clone(),
                message_id: message_id.to_string(),
                async_settled: *async_settled,
            }),
            _ => result.push(TranscriptItem::Subagent {
                id: sub_id,
                tool_call_id: part_id.to_string(),
                spec_index: spec_index as u32,
                name: sub_name,
                task,
                context: item_context,
                status: SubagentStatus::Running,
                started_at: if capture_timing { Some(now_ms()) } else { None },
                duration_ms: None,
                result: None,
                job_id: None,
                message_id: message_id.to_string(),
                async_settled: false,
            }),
        }
    }
    result
}
