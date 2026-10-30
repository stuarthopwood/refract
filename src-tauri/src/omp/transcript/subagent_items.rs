// Builds/updates `subagent` items from a batch `task()` call's live frames and history results.
// Stage membership keys on the owning message id, not timing: reopened history has no timing (#563).

use std::sync::Arc;

use serde_json::Value;

use super::notice_prefixes::HIDDEN_TOOL_NOTICE_PREFIX;
use super::{
    now_ms, NoticeLevel, SubagentStatus, TranscriptItem, ASYNC_RESULT_CUSTOM_TYPE,
    SUBAGENT_NAME_LENGTH,
};

/// Error notice for a hidden tool's failure.
pub(super) fn hidden_tool_failure_notice(
    tool_call_id: &str,
    tool_name: &str,
    output: &str,
) -> TranscriptItem {
    let text = if output.is_empty() {
        format!("{tool_name} failed.")
    } else {
        output.to_string()
    };
    TranscriptItem::Notice {
        id: format!("{HIDDEN_TOOL_NOTICE_PREFIX}{tool_call_id}"),
        level: NoticeLevel::Error,
        text,
    }
}

/// Reads `args.tasks[]` defensively; a malformed array makes the caller render a plain `tool` item.
pub(super) fn read_task_specs(args: &Value) -> Vec<Value> {
    args.get("tasks")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|t| t.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// Reads the batch call's shared `context` (its first line names the Stage, #941); `None` if absent.
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

/// Upserts one `subagent` item per spec, keyed `subagent:<tool_call_id>:<index>`.
/// `message_id` is empty here (no snapshot yet); the later snapshot path fills it in.
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
        // `context` is shared by the whole batch: stored on index 0 only; the renderer dedupes (#941).
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

/// `pending`/`running` are the only in-flight statuses; any other string is a completion/failure.
/// `running` must not hit the `Done` catch-all or a live agent shows as finished.
fn map_progress_status(status: Option<&str>) -> SubagentStatus {
    match status {
        Some("cancelled") | Some("aborted") => SubagentStatus::Cancelled,
        Some("failed") | Some("error") => SubagentStatus::Error,
        Some("pending") | Some("running") => SubagentStatus::Running,
        None => SubagentStatus::Running,
        Some(_) => SubagentStatus::Done,
    }
}

/// Applies a `task` call's live end or history `toolResult` to every `subagent` item sharing
/// `tool_call_id`; returns `items` unchanged when none exist so callers fall back to a `tool` item.
pub(super) fn apply_batch_task_result(
    items: Vec<Arc<TranscriptItem>>,
    tool_call_id: &str,
    is_error: bool,
    details: &Value,
    live: bool,
    turn_abort_requested: bool, // issue #911 (gate-fix): still-running member settles Cancelled, not Error
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
            let was_running = matches!(status, SubagentStatus::Running);
            let entry_job_id = entry
                .and_then(|e| e.get("id"))
                .and_then(Value::as_str)
                .map(String::from);
            // On batch failure a row's progress status wins only if `Cancelled`; else `Error`, so
            // a lingering `pending` never spins forever (#563). A still-Running member during Stop
            // also settles `Cancelled` (#911).
            if is_error {
                let entry_status = entry.and_then(|e| e.get("status")).and_then(Value::as_str);
                *status = match map_progress_status(entry_status) {
                    SubagentStatus::Cancelled => SubagentStatus::Cancelled,
                    _ if turn_abort_requested && was_running => SubagentStatus::Cancelled,
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

/// Applies an `async-result`/`wait` `details.jobs[]` list: the authoritative per-subagent completion.
///
/// The message has no `tool_call_id`, and a job id is only observed (not guaranteed) to echo the
/// label, so a later Stage's job must not clobber an earlier settled Stage's row (#989).
/// A row is settled once a job with real data resolves it; label-echo fallbacks never settle.
/// The caller applies a message's jobs once, on `message_end`.
///
/// Candidates among unsettled rows rank by: still-Running first; then (Running only) `job_id`
/// match over label-only; then latest `started_at`. Each job claims at most one item.
/// Known limit: overlapping same-name jobs are a best-effort guess until #712's
/// `parentToolCallId` lands.
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
        // omp's job records use `failed`/`error` (-> error) and `cancelled`/`aborted` (-> Cancelled).
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

        // Ranked (is_running, running && job_id match, started_at). A non-running row must not
        // out-rank a label-only match on a stale `job_id` (#989).
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
            let key = (is_running, is_running && matches_job_id, started);
            if best.is_none_or(|(b_running, b_job_id, b_started, _)| {
                key >= (b_running, b_job_id, b_started)
            }) {
                best = Some((key.0, key.1, started, item_index));
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

/// `details.jobs[]` reader shared by `tool_execution_end`/`toolResult` for the `wait` tool.
pub(super) fn jobs_from_details(details: &Value) -> Option<Vec<Value>> {
    details.get("jobs").and_then(Value::as_array).cloned()
}

/// Returns the patched items when `message` is a batch-subagent result carrier, else `None`.
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

/// Builds one message's `subagent` items from its echoed `task` call; unlike the live-start path
/// the owning message id is known here, so `message_id` is stamped for real.
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
        // `context` is stored once, on spec index 0 only (see `upsert_subagent_items`).
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
