// Port of `src/main/omp/transcript.ts` (tasks.md T020): builds the renderer-facing
// `TranscriptItem[]` from OMP's own message history (`TranscriptState::from_history`) and from
// live rpc-ui frames (`TranscriptState::apply_frame`). Pure data transformation: no I/O.
//
// Unlike the TS source, this module has no strongly typed `Frame`/`OmpMessage` union to work
// against (`omp::process` deliberately forwards every non-response frame as raw
// `serde_json::Value`, see that module's own header comment) -- every frame/message field is
// read defensively by name, the same way `transcript.ts` itself already reads every `unknown`
// (`args`, `details`, custom-message payloads) rather than trusting a static type. Field names
// on the wire are unchanged from `src/shared/frames.ts`/`src/shared/model.ts`.
//
// Change-detection deviation (documented per the Slice C/Phase 3 facade contract): `transcript.ts`
// diffs by JS object identity (`replaceMessageItems` preserves the reference of any item it did
// not touch). `TranscriptItem` here derives `PartialEq` and every "did this change" signal in this
// module (`TranscriptState::apply_frame`'s return value, `settle_*`'s return value) is computed by
// comparing the item list by VALUE before and after, not by reference. This is a strictly more
// precise definition of "unchanged" than reference identity (it can never report a change for an
// item whose fields are all still the same), so it is a safe substitute for `diff.rs`'s own
// `diff_transcript`, which needs the same signal.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::diff::{finalize_live_transcript, merge_history_with_live};

// ---------------------------------------------------------------------------
// Wire types (`src/shared/model.ts` `TranscriptItem`)
// ---------------------------------------------------------------------------

/// One renderer-facing transcript row. Wire-identical to `src/shared/model.ts`'s
/// `TranscriptItem` union: each variant's `kind` tag and field names match the TS shape
/// field-for-field (`#[serde(tag = "kind", rename_all = "kebab-case")]` reproduces the TS
/// variant names; a `rename_all = "camelCase"` on each multi-word-field variant reproduces the
/// TS field names), so a serialized value round-trips through `src/renderer` unchanged.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TranscriptItem {
    User {
        id: String,
        text: String,
        at: i64,
    },
    #[serde(rename_all = "camelCase")]
    AssistantText {
        id: String,
        text: String,
        streaming: bool,
    },
    #[serde(rename_all = "camelCase")]
    Thinking {
        id: String,
        text: String,
        streaming: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        id: String,
        tool_call_id: String,
        tool: String,
        target: String,
        status: ToolStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
        /// `unknown` on the TS side; serialized as absent (not `null`) when unset, matching
        /// `JSON.stringify` dropping an explicit `args: undefined`.
        #[serde(default, skip_serializing_if = "Value::is_null")]
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// Never set by this module (renderer-computed from `edit`/`write`, per `transcript.ts`'s
        /// own comment); kept only for wire parity with `ToolItem['diff']`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edit: Option<EditField>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        write: Option<WriteField>,
    },
    #[serde(rename_all = "camelCase")]
    Subagent {
        id: String,
        tool_call_id: String,
        spec_index: u32,
        name: String,
        task: String,
        status: SubagentStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_id: Option<String>,
    },
    #[serde(rename = "agent-message")]
    AgentMessage {
        id: String,
        from: String,
        to: String,
        text: String,
        at: i64,
    },
    #[serde(rename_all = "camelCase")]
    Advisory {
        id: String,
        severity: AdvisorySeverity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        advisor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turns_ago: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        guidance: Option<String>,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Request {
        id: String,
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved: Option<RequestResolution>,
    },
    Notice {
        id: String,
        level: NoticeLevel,
        text: String,
    },
}

impl TranscriptItem {
    /// Every variant's `id` field (the key `replace_message_items`/`diff_transcript` match on).
    pub fn id(&self) -> &str {
        match self {
            TranscriptItem::User { id, .. }
            | TranscriptItem::AssistantText { id, .. }
            | TranscriptItem::Thinking { id, .. }
            | TranscriptItem::Tool { id, .. }
            | TranscriptItem::Subagent { id, .. }
            | TranscriptItem::AgentMessage { id, .. }
            | TranscriptItem::Advisory { id, .. }
            | TranscriptItem::Request { id, .. }
            | TranscriptItem::Notice { id, .. } => id,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Running,
    Done,
    Error,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubagentStatus {
    Running,
    Done,
    Error,
    Exited,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdvisorySeverity {
    Nit,
    Concern,
    Blocker,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RequestResolution {
    Approved,
    Denied,
    Answered,
    Cancelled,
}

/// From an `edit` tool's `tool_execution_end` `result.details` (or history's
/// `toolResult.details`); the renderer builds the unified diff (T025).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditField {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

/// From a `write` tool's args; the renderer diffs it against a cached prior read/edit of the
/// same path (T025).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WriteField {
    pub path: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Constants (`src/shared/model.ts`, `transcript.ts`)
// ---------------------------------------------------------------------------

const MAX_TARGET_LENGTH: usize = 200;
const SUBAGENT_NAME_LENGTH: usize = 60;

/// Tool names the agent calls for its own bookkeeping (T086, FR-052): a call to one of these
/// never becomes a `tool` item (`src/shared/model.ts` `HIDDEN_TOOLS`).
const HIDDEN_TOOLS: &[&str] = &["todo"];

/// `id` prefix for the `notice` a hidden tool's failure becomes (T086, FR-052;
/// `HIDDEN_TOOL_NOTICE_PREFIX`).
const HIDDEN_TOOL_NOTICE_PREFIX: &str = "hidden-tool-error:";

/// `id` prefix for a `notice` built from a `command_output`/`notice` frame that arrived before
/// the user had taken any action in this agent process (`STARTUP_NOTICE_PREFIX`).
const STARTUP_NOTICE_PREFIX: &str = "startup-notice:";

const ASYNC_RESULT_CUSTOM_TYPE: &str = "async-result";
const ADVISORY_CUSTOM_TYPE: &str = "advisor";
const AGENT_MESSAGE_CUSTOM_TYPES: &[&str] = &[
    "agent-message",
    "agent_message",
    "irc-message",
    "irc_message",
    "subagent-message",
];

fn is_advisory_severity(value: &str) -> bool {
    matches!(value, "nit" | "concern" | "blocker")
}

/// `src/shared/frames.ts`'s `KNOWN_FRAME_TYPES`: every frame type `apply_frame` (and OMP itself)
/// can emit. Exposed so `session::agent` (Phase 3) can mirror `SessionAgent.onFrame`'s own
/// `isKnownFrame` gate before deciding whether an unrecognised frame can be ignored.
pub fn is_known_frame_type(frame_type: &str) -> bool {
    matches!(
        frame_type,
        "ready"
            | "response"
            | "agent_start"
            | "agent_end"
            | "message_start"
            | "message_update"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_end"
            | "tool_execution_update"
            | "queue_update"
            | "extension_ui_request"
            | "prompt_result"
            | "session_settled"
            | "available_commands_update"
            | "command_output"
            | "notice"
            | "rpc_chunk"
            | "btw_delta"
            | "btw_record"
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads a JSON field as an epoch-millisecond timestamp the same way `transcript.ts` reads
/// `message.timestamp` (`typeof message.timestamp === 'number'`): any JSON number, not only one
/// that fits `i64` exactly.
fn as_timestamp(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_f64).map(|f| f as i64)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

// ---------------------------------------------------------------------------
// Tool row fields (port of `transcript.ts` lines 34-104)
// ---------------------------------------------------------------------------

/// Port of `firstStringArg`. Note: `serde_json::Map`'s default iteration order is key-sorted,
/// not JS's insertion order (`preserve_order` is not a declared `serde_json` feature and
/// Cargo.toml must not be edited in this slice) -- for a tool whose first string-typed argument
/// this function must guess at (anything but `edit`/`read`/`write`/`bash`/`grep`/`glob`, see
/// `extract_target`), the *which* string picked first can differ from the TS build. Documented
/// deviation, not a defect: this only affects the `target` label shown on an uncommon tool's row.
fn first_string_arg(args: &Value) -> String {
    if let Some(map) = args.as_object() {
        for value in map.values() {
            if let Some(s) = value.as_str() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// Hand-rolled port of `EDIT_HEADER_PATH_RE = /\[(.+?)#[0-9A-Fa-f]{4}\]/` (the `regex` crate is
/// not a declared dependency; Cargo.toml must not be edited in this slice). Scans for the first
/// `[`, then the shortest non-empty run of characters before a `#` that is itself followed by
/// exactly four hex digits and a closing `]` -- the same non-greedy `.+?` semantics as the
/// original regex.
fn find_edit_header_path(s: &str) -> Option<String> {
    let mut scan_from = 0usize;
    while let Some(open_rel) = s[scan_from..].find('[') {
        let open = scan_from + open_rel;
        let mut search_from = open + 1;
        loop {
            match s[search_from..].find('#') {
                None => break,
                Some(hash_rel) => {
                    let hash = search_from + hash_rel;
                    if hash > open + 1 && is_hex4_close(s, hash) {
                        return Some(s[open + 1..hash].to_string());
                    }
                    search_from = hash + 1;
                }
            }
        }
        scan_from = open + 1;
    }
    None
}

fn is_hex4_close(s: &str, hash_index: usize) -> bool {
    let rest = s.as_bytes().get(hash_index + 1..);
    match rest {
        Some(bytes) if bytes.len() >= 5 => {
            bytes[0..4].iter().all(u8::is_ascii_hexdigit) && bytes[4] == b']'
        }
        _ => false,
    }
}

fn extract_edit_target(input: Option<&str>) -> String {
    input.and_then(find_edit_header_path).unwrap_or_default()
}

/// Tool row fields: target = the tool's primary argument. Port of `extractTarget`.
fn extract_target(tool: &str, args: &Value) -> String {
    let object_args = args.is_object();
    let raw = match tool {
        "edit" if object_args => {
            let edit_target = extract_edit_target(args.get("input").and_then(Value::as_str));
            if !edit_target.is_empty() {
                edit_target
            } else {
                first_string_arg(args)
            }
        }
        "read" | "write" if object_args => args
            .get("path")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| first_string_arg(args)),
        "bash" if object_args => args
            .get("command")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| first_string_arg(args)),
        "grep" | "glob" if object_args => args
            .get("pattern")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| first_string_arg(args)),
        _ => first_string_arg(args),
    };
    truncate_chars(&raw, MAX_TARGET_LENGTH)
}

fn build_write_field(tool: &str, args: &Value) -> Option<WriteField> {
    if tool != "write" {
        return None;
    }
    let obj = args.as_object()?;
    let path = obj.get("path")?.as_str()?.to_string();
    let content = obj.get("content")?.as_str()?.to_string();
    Some(WriteField { path, content })
}

fn build_edit_field(tool: &str, details: &Value) -> Option<EditField> {
    if tool != "edit" {
        return None;
    }
    let obj = details.as_object()?;
    let path = obj.get("path")?.as_str()?.to_string();
    let old_text = obj.get("oldText")?.as_str()?.to_string();
    let new_text = obj.get("newText")?.as_str()?.to_string();
    Some(EditField {
        path,
        old_text,
        new_text,
    })
}

/// Concatenates every `{ type: 'text', text }` part's `text`, in order (`joinText`).
fn join_text(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect()
}

// ---------------------------------------------------------------------------
// Subagents (T078, FINDINGS item 22(e)): port of `transcript.ts` lines 110-278
// ---------------------------------------------------------------------------

/// Reads `args.tasks[]` defensively (port of `readTaskSpecs`): a malformed or absent array means
/// the caller falls back to rendering the call as a plain `tool` item instead of silently
/// dropping it.
fn read_task_specs(args: &Value) -> Vec<Value> {
    args.get("tasks")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|t| t.is_object()).cloned().collect())
        .unwrap_or_default()
}

fn task_text(spec: &Value) -> String {
    spec.get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn subagent_name(spec: &Value) -> String {
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
/// Port of `upsertSubagentItems`.
fn upsert_subagent_items(
    mut items: Vec<Arc<TranscriptItem>>,
    tool_call_id: &str,
    specs: &[Value],
) -> Vec<Arc<TranscriptItem>> {
    for (index, spec) in specs.iter().enumerate() {
        let id = format!("subagent:{tool_call_id}:{index}");
        let name = subagent_name(spec);
        let task = task_text(spec);
        let existing_pos = items.iter().position(|item| item.id() == id);
        match existing_pos {
            Some(pos) => {
                if let TranscriptItem::Subagent {
                    name: n, task: t, ..
                } = Arc::make_mut(&mut items[pos])
                {
                    *n = name;
                    *t = task;
                }
            }
            None => items.push(Arc::new(TranscriptItem::Subagent {
                id,
                tool_call_id: tool_call_id.to_string(),
                spec_index: index as u32,
                name,
                task,
                status: SubagentStatus::Running,
                started_at: Some(now_ms()),
                duration_ms: None,
                result: None,
                job_id: None,
            })),
        }
    }
    items
}

/// `pending` (still running) is the only status FINDINGS item 22(e) actually observed; any other
/// string is a plain completion/failure signal. Port of `mapProgressStatus`.
fn map_progress_status(status: Option<&str>) -> SubagentStatus {
    match status {
        Some("failed") | Some("error") | Some("cancelled") | Some("aborted") => {
            SubagentStatus::Error
        }
        Some("pending") => SubagentStatus::Running,
        None => SubagentStatus::Running,
        Some(_) => SubagentStatus::Done,
    }
}

/// Applies a `task` call's own `tool_execution_end` (live, `live = true`) or `toolResult`
/// (history) result to every `subagent` item sharing `tool_call_id`. Port of
/// `applyBatchTaskResult`. Returns `items` unchanged when `tool_call_id` has no subagent items at
/// all, so callers can fall through to the generic `tool` item path for a malformed `task` call.
fn apply_batch_task_result(
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
            // A hard batch failure (`is_error`) flips every subagent row to `error`, even one
            // whose `progress[i].status` is still `"pending"` -- otherwise that row spins
            // forever.
            if is_error {
                *status = fallback_status;
                if let Some(jid) = entry_job_id {
                    *job_id = Some(jid);
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
fn apply_async_result_jobs(
    items: Vec<Arc<TranscriptItem>>,
    jobs: &[Value],
) -> Vec<Arc<TranscriptItem>> {
    items
        .into_iter()
        .map(|mut item| {
            let TranscriptItem::Subagent { name, job_id, .. } = item.as_ref() else {
                return item;
            };
            let job_id_of = |j: &Value| -> Option<String> {
                j.get("jobId")
                    .and_then(Value::as_str)
                    .or_else(|| j.get("id").and_then(Value::as_str))
                    .map(String::from)
            };
            let by_job_id = jobs
                .iter()
                .find(|j| job_id_of(j).as_deref() == job_id.as_deref() && job_id.is_some());
            let by_label = if job_id.is_none() {
                jobs.iter()
                    .find(|j| j.get("label").and_then(Value::as_str) == Some(name.as_str()))
            } else {
                None
            };
            let job = match by_job_id.or(by_label) {
                Some(j) => j,
                None => return item,
            };
            let job_status = job.get("status").and_then(Value::as_str);
            if matches!(job_status, Some("pending") | Some("running")) {
                return item;
            }
            // The installed omp 18.5.1 binary's own job records use `'failed'`/`'cancelled'`
            // (direct binary inspection, 2026-10-03): both, plus `'error'`/`'aborted'`, must map
            // to `error`, never fall through to `done`.
            let failed = matches!(
                job_status,
                Some("failed") | Some("error") | Some("cancelled") | Some("aborted")
            );
            let error_text = job.get("errorText").and_then(Value::as_str);
            let result_text = job.get("resultText").and_then(Value::as_str);
            let schema_data = job.get("schema").and_then(|s| s.get("data"));
            let label = job.get("label").and_then(Value::as_str);
            let new_job_id = job_id_of(job);
            let new_duration = job
                .get("durationMs")
                .and_then(Value::as_f64)
                .map(|f| f as i64);
            // `Arc::make_mut` clones the value only when another reference is still outstanding,
            // so an untouched (`return item` above) or no-op subagent row never pays a copy.
            if let TranscriptItem::Subagent {
                status,
                duration_ms,
                result,
                job_id,
                ..
            } = Arc::make_mut(&mut item)
            {
                let new_result = if failed && error_text.is_some() {
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
                *status = if failed {
                    SubagentStatus::Error
                } else {
                    SubagentStatus::Done
                };
                *result = new_result;
                if let Some(d) = new_duration {
                    *duration_ms = Some(d);
                }
                if let Some(jid) = new_job_id {
                    *job_id = Some(jid);
                }
            }
            item
        })
        .collect()
}

/// `details.jobs[]` reader shared by `tool_execution_end`/`toolResult` for the `wait` tool
/// (port of `jobsFromDetails`).
fn jobs_from_details(details: &Value) -> Option<Vec<Value>> {
    details.get("jobs").and_then(Value::as_array).cloned()
}

/// Returns the patched items when `message` is a batch-subagent result carrier, `None` when it
/// is not one at all. Port of `tryApplyAsyncResult`.
fn try_apply_async_result(
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

// ---------------------------------------------------------------------------
// Subagent-to-parent IRC messages (T079, FR-048): port of `transcript.ts` lines 292-336
// ---------------------------------------------------------------------------

fn try_build_agent_message(
    message_id: &str,
    custom_type: &str,
    message: &Value,
) -> Option<TranscriptItem> {
    let details = message.get("details");
    let looks_like_agent_message = AGENT_MESSAGE_CUSTOM_TYPES.contains(&custom_type)
        || details
            .map(|d| {
                d.get("from").and_then(Value::as_str).is_some()
                    || d.get("sender").and_then(Value::as_str).is_some()
            })
            .unwrap_or(false);
    if !looks_like_agent_message {
        return None;
    }
    let d = details;
    let from = d
        .and_then(|d| d.get("from").and_then(Value::as_str))
        .or_else(|| d.and_then(|d| d.get("sender").and_then(Value::as_str)))
        .unwrap_or("subagent")
        .to_string();
    let to = d
        .and_then(|d| d.get("to").and_then(Value::as_str))
        .or_else(|| d.and_then(|d| d.get("recipient").and_then(Value::as_str)))
        .unwrap_or("main agent")
        .to_string();
    let text = d
        .and_then(|d| d.get("text").and_then(Value::as_str))
        .or_else(|| d.and_then(|d| d.get("message").and_then(Value::as_str)))
        .map(String::from)
        .unwrap_or_else(|| {
            message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        });
    let at = as_timestamp(message, "timestamp").unwrap_or_else(now_ms);
    Some(TranscriptItem::AgentMessage {
        id: format!("agent-message:{message_id}"),
        from,
        to,
        text,
        at,
    })
}

// ---------------------------------------------------------------------------
// Advisory notes (T084, FR-051): port of `transcript.ts` lines 338-500
// ---------------------------------------------------------------------------

/// A numeric character reference is only valid when it names a real Unicode scalar value: at
/// most U+10FFFF, and never a lone surrogate. Port of `isValidXmlCodePoint`.
fn is_valid_xml_code_point(code_point: u32) -> bool {
    code_point <= 0x10ffff && !(0xd800..=0xdfff).contains(&code_point)
}

/// Decodes the five XML entities (plus numeric character references) valid in XML-escaped
/// attribute values/text nodes; anything else is left untouched. Hand-rolled port of
/// `decodeXmlEntities` (the `regex` crate is not a declared dependency).
fn decode_xml_entities(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            // Advance by one UTF-8 scalar, not one byte, to stay on a char boundary.
            let ch_len = text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        if let Some((replacement, consumed)) = decode_one_entity(&text[i..]) {
            out.push_str(&replacement);
            i += consumed;
        } else {
            out.push('&');
            i += 1;
        }
    }
    out
}

/// Tries to decode one entity/character-reference starting at `&` in `rest`. Returns the decoded
/// text and the number of bytes consumed (including the leading `&`), or `None` when `rest` does
/// not start with a recognised, well-formed, in-range entity (the caller then copies the lone
/// `&` through unchanged, matching the original regex's "no match" fallthrough).
fn decode_one_entity(rest: &str) -> Option<(String, usize)> {
    debug_assert!(rest.starts_with('&'));
    for (name, ch) in [
        ("lt", '<'),
        ("gt", '>'),
        ("amp", '&'),
        ("quot", '"'),
        ("apos", '\''),
    ] {
        let needle = format!("&{name};");
        if rest.starts_with(&needle) {
            return Some((ch.to_string(), needle.len()));
        }
    }
    if let Some(body) = rest
        .strip_prefix("&#x")
        .or_else(|| rest.strip_prefix("&#X"))
    {
        let hex_len = body
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .count()
            .min(6);
        if hex_len > 0 && body.as_bytes().get(hex_len) == Some(&b';') {
            let digits = &body[..hex_len];
            if let Ok(code_point) = u32::from_str_radix(digits, 16) {
                if is_valid_xml_code_point(code_point) {
                    if let Some(ch) = char::from_u32(code_point) {
                        return Some((ch.to_string(), 3 + hex_len + 1));
                    }
                }
            }
        }
        return None;
    }
    if let Some(body) = rest.strip_prefix("&#") {
        let dec_len = body.chars().take_while(char::is_ascii_digit).count().min(7);
        if dec_len > 0 && body.as_bytes().get(dec_len) == Some(&b';') {
            let digits = &body[..dec_len];
            if let Ok(code_point) = digits.parse::<u32>() {
                if is_valid_xml_code_point(code_point) {
                    if let Some(ch) = char::from_u32(code_point) {
                        return Some((ch.to_string(), 2 + dec_len + 1));
                    }
                }
            }
        }
        return None;
    }
    None
}

/// One `name="value"`/`name='value'` attribute, as found by `scan_advisory_attrs`.
struct RawAttr {
    name: String,
    value: String,
}

/// Hand-rolled scanner for `ADVISORY_ATTR_RE = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g`
/// over one tag's own attribute-list capture group.
fn scan_advisory_attrs(attr_source: &str) -> Vec<RawAttr> {
    let bytes = attr_source.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    let mut out = Vec::new();
    while i < len {
        // Skip to the next attribute-name start: an ASCII letter.
        while i < len && !bytes[i].is_ascii_alphabetic() {
            i += 1;
        }
        if i >= len {
            break;
        }
        let name_start = i;
        i += 1;
        while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
        {
            i += 1;
        }
        let name = &attr_source[name_start..i];
        let mut j = i;
        while j < len && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= len || bytes[j] != b'=' {
            i = name_start + 1;
            continue;
        }
        j += 1;
        while j < len && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let quote = match bytes.get(j) {
            Some(b'"') => b'"',
            Some(b'\'') => b'\'',
            _ => {
                i = name_start + 1;
                continue;
            }
        };
        j += 1;
        let value_start = j;
        while j < len && bytes[j] != quote {
            j += 1;
        }
        if j >= len {
            i = name_start + 1;
            continue;
        }
        out.push(RawAttr {
            name: name.to_string(),
            value: attr_source[value_start..j].to_string(),
        });
        i = j + 1;
    }
    out
}

/// Reads one tag's attribute-list capture group into a name->value map; a duplicate attribute
/// name means the source was never well-formed, so the whole element is a parse failure (`None`),
/// not a silent keep-last-value. Port of `parseAdvisoryAttrs`.
fn parse_advisory_attrs(attr_source: &str) -> Option<std::collections::HashMap<String, String>> {
    let mut attrs = std::collections::HashMap::new();
    for attr in scan_advisory_attrs(attr_source) {
        if attrs.contains_key(&attr.name) {
            return None;
        }
        attrs.insert(attr.name, decode_xml_entities(&attr.value));
    }
    Some(attrs)
}

/// One `<advisory ...>` opening tag's own attribute-list capture group and the byte offset just
/// past the tag's closing `>`.
struct OpenTagMatch {
    attr_source: String,
    body_start: usize,
}

/// Hand-rolled port of
/// `ADVISORY_OPEN_TAG_RE = /<advisory\b((?:\s+[A-Za-z][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/g`:
/// matches only the opening tag itself (no body capture), scanning from `from`.
fn find_advisory_open_tag(content: &str, from: usize) -> Option<OpenTagMatch> {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut search_from = from;
    while let Some(rel) = content[search_from..].find("<advisory") {
        let tag_start = search_from + rel;
        let after_name = tag_start + "<advisory".len();
        // `\b` after `advisory`: the next byte must not continue an identifier.
        let word_boundary_ok = bytes
            .get(after_name)
            .map(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
            .unwrap_or(true);
        if !word_boundary_ok {
            search_from = tag_start + 1;
            continue;
        }
        // Scan `(\s+name=...)*` repeatedly, then optional trailing whitespace and `>`.
        let mut i = after_name;
        let attrs_start = i;
        loop {
            let ws_start = i;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i == ws_start {
                break; // no whitespace: no further attribute can start here
            }
            let name_start = i;
            if i >= len || !bytes[i].is_ascii_alphabetic() {
                i = ws_start;
                break;
            }
            i += 1;
            while i < len
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
            {
                i += 1;
            }
            let _name = &content[name_start..i];
            let mut j = i;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j >= len || bytes[j] != b'=' {
                i = ws_start;
                break;
            }
            j += 1;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let quote = match bytes.get(j) {
                Some(b'"') => b'"',
                Some(b'\'') => b'\'',
                _ => {
                    i = ws_start;
                    break;
                }
            };
            j += 1;
            let value_start = j;
            while j < len && bytes[j] != quote {
                j += 1;
            }
            if j >= len {
                i = ws_start;
                break;
            }
            i = j + 1;
            let _ = value_start;
        }
        let attrs_end = i;
        let attr_source = content[attrs_start..attrs_end].to_string();
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < len && bytes[i] == b'>' {
            return Some(OpenTagMatch {
                attr_source,
                body_start: i + 1,
            });
        }
        // This `<advisory` did not resolve to a well-formed opening tag; keep scanning after it.
        search_from = tag_start + 1;
    }
    None
}

const ADVISORY_CLOSE_TAG: &str = "</advisory>";

/// Parses every `<advisory ...>note</advisory>` element out of `content` into its own item --
/// `[]` when none are found at all. Port of `parseAdvisoryElements`; see the TS doc comment for
/// why the closing-tag search is a single forward `indexOf` per open tag (linear total scan even
/// against many unclosed `<advisory` tags).
fn parse_advisory_elements(message_id: &str, content: &str) -> Vec<TranscriptItem> {
    let mut items = Vec::new();
    let mut index = 0usize;
    let mut search_from = 0usize;
    while let Some(open_match) = find_advisory_open_tag(content, search_from) {
        let body_start = open_match.body_start;
        let Some(close_rel) = content[body_start..].find(ADVISORY_CLOSE_TAG) else {
            break;
        };
        let close_index = body_start + close_rel;
        let attrs = parse_advisory_attrs(&open_match.attr_source);
        search_from = close_index + ADVISORY_CLOSE_TAG.len();
        let Some(attrs) = attrs else { continue };
        let severity = attrs
            .get("severity")
            .filter(|s| is_advisory_severity(s))
            .map(|s| match s.as_str() {
                "concern" => AdvisorySeverity::Concern,
                "blocker" => AdvisorySeverity::Blocker,
                _ => AdvisorySeverity::Nit,
            })
            .unwrap_or(AdvisorySeverity::Nit);
        let turns_ago = attrs
            .get("turns_ago")
            .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
            .and_then(|v| v.parse::<i64>().ok());
        items.push(TranscriptItem::Advisory {
            id: format!("{message_id}:{index}"),
            severity,
            advisor: attrs.get("advisor").cloned(),
            turns_ago,
            guidance: attrs.get("guidance").cloned(),
            text: decode_xml_entities(content[body_start..close_index].trim())
                .trim()
                .to_string(),
        });
        index += 1;
    }
    items
}

/// Returns the parsed `advisory` item(s) when `message` carries OMP's confirmed wire shape for
/// one (`customType: 'advisor'`), `None` when it does not. Port of `tryBuildAdvisoryItems`: a
/// confirmed advisory message that yields zero well-formed elements becomes a plain `notice`
/// instead (FR-051), never silently dropped.
fn try_build_advisory_items(
    message_id: &str,
    custom_type: &str,
    content: &str,
) -> Option<Vec<TranscriptItem>> {
    if custom_type != ADVISORY_CUSTOM_TYPE {
        return None;
    }
    let parsed = parse_advisory_elements(message_id, content);
    if !parsed.is_empty() {
        return Some(parsed);
    }
    Some(vec![TranscriptItem::Notice {
        id: message_id.to_string(),
        level: NoticeLevel::Info,
        text: content.to_string(),
    }])
}

fn hidden_tool_failure_notice(tool_call_id: &str, tool_name: &str, output: &str) -> TranscriptItem {
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

// ---------------------------------------------------------------------------
// Assistant message content parts -> items (port of `buildAssistantItems`, lines 514-604)
// ---------------------------------------------------------------------------

/// Builds the items for one assistant message's `content[]` snapshot. `capture_timing` is
/// `false` for `from_history` (a historical message carries only one timestamp for its whole
/// life, so stamping one from `now_ms()` at load time would show a meaningless duration).
fn build_assistant_items(
    message_id: &str,
    parts: &[Value],
    streaming: bool,
    existing_items: &[Arc<TranscriptItem>],
    capture_timing: bool,
) -> Vec<TranscriptItem> {
    let prefix = format!("{message_id}:");
    let existing_for_message: Vec<&TranscriptItem> = existing_items
        .iter()
        .map(|item| item.as_ref())
        .filter(|item| item.id() == message_id || item.id().starts_with(&prefix))
        .collect();
    let mut result: Vec<TranscriptItem> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let id = format!("{message_id}:{index}");
        let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
        match part_type {
            "text" => {
                let text = part
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                result.push(TranscriptItem::AssistantText {
                    id,
                    text,
                    streaming,
                });
            }
            "thinking" => {
                let thinking = part.get("thinking").and_then(Value::as_str).unwrap_or("");
                if thinking.is_empty() {
                    continue;
                }
                let text = thinking.to_string();
                if !capture_timing {
                    result.push(TranscriptItem::Thinking {
                        id,
                        text,
                        streaming,
                        started_at: None,
                        ended_at: None,
                    });
                    continue;
                }
                let existing = existing_for_message.iter().find_map(|item| {
                    if let TranscriptItem::Thinking {
                        id: tid,
                        started_at,
                        ended_at,
                        ..
                    } = item
                    {
                        if *tid == id {
                            return Some((*started_at, *ended_at));
                        }
                    }
                    None
                });
                let (existing_started, existing_ended) = existing.unwrap_or((None, None));
                let started_at = Some(existing_started.unwrap_or_else(now_ms));
                let ended_at = if !streaming {
                    Some(existing_ended.unwrap_or_else(now_ms))
                } else {
                    existing_ended
                };
                result.push(TranscriptItem::Thinking {
                    id,
                    text,
                    streaming,
                    started_at,
                    ended_at,
                });
            }
            "toolCall" => {
                let part_id = part
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let name = part
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments = part.get("arguments").cloned().unwrap_or(Value::Null);
                if HIDDEN_TOOLS.contains(&name.as_str()) {
                    continue;
                }
                if name == "task" {
                    let specs = read_task_specs(&arguments);
                    if !specs.is_empty() {
                        for (spec_index, spec) in specs.iter().enumerate() {
                            let sub_id = format!("subagent:{part_id}:{spec_index}");
                            let sub_name = subagent_name(spec);
                            let task = task_text(spec);
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
                                    ..
                                }) => result.push(TranscriptItem::Subagent {
                                    id: id.clone(),
                                    tool_call_id: tool_call_id.clone(),
                                    spec_index: *spec_index,
                                    name: sub_name,
                                    task,
                                    status: *status,
                                    started_at: *started_at,
                                    duration_ms: *duration_ms,
                                    result: sub_result.clone(),
                                    job_id: job_id.clone(),
                                }),
                                _ => result.push(TranscriptItem::Subagent {
                                    id: sub_id,
                                    tool_call_id: part_id.clone(),
                                    spec_index: spec_index as u32,
                                    name: sub_name,
                                    task,
                                    status: SubagentStatus::Running,
                                    started_at: if capture_timing { Some(now_ms()) } else { None },
                                    duration_ms: None,
                                    result: None,
                                    job_id: None,
                                }),
                            }
                        }
                        continue;
                    }
                }
                let existing = existing_for_message.iter().find(
                    |item| matches!(item, TranscriptItem::Tool { id: tid, .. } if *tid == id),
                );
                let target = extract_target(&name, &arguments);
                let write = build_write_field(&name, &arguments);
                match existing {
                    Some(TranscriptItem::Tool {
                        status,
                        started_at,
                        duration_ms,
                        output,
                        diff,
                        details,
                        edit,
                        write: old_write,
                        ..
                    }) => result.push(TranscriptItem::Tool {
                        id,
                        tool_call_id: part_id,
                        tool: name,
                        target,
                        status: *status,
                        started_at: *started_at,
                        duration_ms: *duration_ms,
                        args: arguments,
                        output: output.clone(),
                        diff: diff.clone(),
                        details: details.clone(),
                        edit: edit.clone(),
                        write: write.or_else(|| old_write.clone()),
                    }),
                    _ => result.push(TranscriptItem::Tool {
                        id,
                        tool_call_id: part_id,
                        tool: name,
                        target,
                        status: ToolStatus::Running,
                        started_at: if capture_timing { Some(now_ms()) } else { None },
                        duration_ms: None,
                        args: arguments,
                        output: None,
                        diff: None,
                        details: None,
                        edit: None,
                        write,
                    }),
                }
            }
            _ => {
                // Unknown content part type: ignore without throwing.
            }
        }
    }
    result
}

/// Replaces every item belonging to `message_id` (single id or `id:index`) with `replacement`,
/// preserving its position; appends at the end for a brand-new message. Also strips any item
/// whose id appears in `replacement` from wherever it currently sits (a `subagent` item is keyed
/// by `tool_call_id`, not `message_id`). Port of `replaceMessageItems`.
fn replace_message_items(
    items: Vec<Arc<TranscriptItem>>,
    message_id: &str,
    replacement: Vec<Arc<TranscriptItem>>,
) -> Vec<Arc<TranscriptItem>> {
    let replacement_ids: HashSet<&str> = replacement.iter().map(|item| item.id()).collect();
    let prefix = format!("{message_id}:");
    let matches = |item: &Arc<TranscriptItem>| -> bool {
        item.id() == message_id
            || item.id().starts_with(&prefix)
            || replacement_ids.contains(item.id())
    };
    if !items.iter().any(matches) {
        let mut items = items;
        items.extend(replacement);
        return items;
    }
    let insert_at = items.iter().position(matches).unwrap_or(items.len());
    let without_message: Vec<Arc<TranscriptItem>> =
        items.into_iter().filter(|item| !matches(item)).collect();
    // `insert_at` was computed against the original list; since every item strictly before it
    // was (by definition of `position`) not a match, it also survives into `without_message`
    // unchanged, so the same index still marks the right splice point.
    let insert_at = insert_at.min(without_message.len());
    let mut result = without_message;
    let tail = result.split_off(insert_at);
    result.extend(replacement);
    result.extend(tail);
    result
}

// ---------------------------------------------------------------------------
// Message snapshot application (port of `applyMessageSnapshot`, lines 629-665)
// ---------------------------------------------------------------------------

/// Borrows `message`'s own `content[]` instead of cloning it (performance finding, 2026-10-13:
/// this runs on every `message_start`/`message_update`/`message_end` frame -- once per streamed
/// token chunk -- and a deep clone of a long assistant message's content array was pure waste
/// when every caller only ever reads it).
fn content_parts(message: &Value) -> &[Value] {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn apply_message_snapshot(
    items: Vec<Arc<TranscriptItem>>,
    message_id: &str,
    message: &Value,
    streaming: bool,
) -> Vec<Arc<TranscriptItem>> {
    if message_id.is_empty() {
        return items;
    }
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    match role {
        "assistant" => {
            let parts = content_parts(message);
            let built = build_assistant_items(message_id, parts, streaming, &items, true);
            replace_message_items(items, message_id, built.into_iter().map(Arc::new).collect())
        }
        "user" => {
            let parts = content_parts(message);
            let text = join_text(parts);
            let at = as_timestamp(message, "timestamp").unwrap_or_else(now_ms);
            replace_message_items(
                items,
                message_id,
                vec![Arc::new(TranscriptItem::User {
                    id: message_id.to_string(),
                    text,
                    at,
                })],
            )
        }
        "custom" => {
            let custom_type = message
                .get("customType")
                .and_then(Value::as_str)
                .unwrap_or("");
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            let details = message.get("details").cloned().unwrap_or(Value::Null);
            if let Some(async_result) = try_apply_async_result(&items, custom_type, &details) {
                return async_result;
            }
            if let Some(advisory_items) = try_build_advisory_items(message_id, custom_type, content)
            {
                return replace_message_items(
                    items,
                    message_id,
                    advisory_items.into_iter().map(Arc::new).collect(),
                );
            }
            if let Some(agent_message) = try_build_agent_message(message_id, custom_type, message) {
                return replace_message_items(items, message_id, vec![Arc::new(agent_message)]);
            }
            if message.get("display").and_then(Value::as_bool) == Some(true) {
                return replace_message_items(
                    items,
                    message_id,
                    vec![Arc::new(TranscriptItem::Notice {
                        id: message_id.to_string(),
                        level: NoticeLevel::Info,
                        text: content.to_string(),
                    })],
                );
            }
            replace_message_items(items, message_id, Vec::new())
        }
        // `developer` is always hidden; `toolResult` live output comes from
        // `tool_execution_end`, not from the message lifecycle frames. Both (and anything else)
        // fall through the wildcard below unchanged (clippy `wildcard_in_or_patterns`: `_` alone
        // already covers them).
        _ => items,
    }
}

// ---------------------------------------------------------------------------
// Live tool-execution frames (port of `applyToolExecutionStart`/`End`, lines 667-754)
// ---------------------------------------------------------------------------

fn apply_tool_execution_start(
    items: Vec<Arc<TranscriptItem>>,
    frame: &Value,
) -> Vec<Arc<TranscriptItem>> {
    let tool_call_id = frame
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_name = frame
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let args = frame.get("args").cloned().unwrap_or(Value::Null);
    if HIDDEN_TOOLS.contains(&tool_name.as_str()) {
        return items;
    }
    if tool_name == "task" {
        let specs = read_task_specs(&args);
        if !specs.is_empty() {
            return upsert_subagent_items(items, &tool_call_id, &specs);
        }
    }
    let target = extract_target(&tool_name, &args);
    let write = build_write_field(&tool_name, &args);
    let has_existing = items.iter().any(|item| {
        matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id)
    });
    if !has_existing {
        let mut items = items;
        items.push(Arc::new(TranscriptItem::Tool {
            id: format!("tool-exec:{tool_call_id}"),
            tool_call_id,
            tool: tool_name,
            target,
            status: ToolStatus::Running,
            started_at: Some(now_ms()),
            duration_ms: None,
            args,
            output: None,
            diff: None,
            details: None,
            edit: None,
            write,
        }));
        return items;
    }
    items
        .into_iter()
        .map(|mut item| {
            let is_target = matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id);
            if is_target {
                if let TranscriptItem::Tool { tool, target: t, status, started_at, args: a, write: old_write, .. } =
                    Arc::make_mut(&mut item)
                {
                    let merged_write = write.clone().or_else(|| old_write.clone());
                    *tool = tool_name.clone();
                    *t = target.clone();
                    *status = ToolStatus::Running;
                    *started_at = Some(now_ms());
                    *a = args.clone();
                    *old_write = merged_write;
                }
            }
            item
        })
        .collect()
}

fn apply_tool_execution_end(
    items: Vec<Arc<TranscriptItem>>,
    frame: &Value,
) -> Vec<Arc<TranscriptItem>> {
    let tool_call_id = frame
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_name = frame
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let is_error = frame
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = frame.get("result").cloned().unwrap_or(Value::Null);
    let result_content = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result_details_opt = result.get("details").cloned();
    let result_details = result_details_opt.clone().unwrap_or(Value::Null);

    if HIDDEN_TOOLS.contains(&tool_name.as_str()) {
        if !is_error {
            return items;
        }
        let mut items = items;
        items.push(Arc::new(hidden_tool_failure_notice(
            &tool_call_id,
            &tool_name,
            &join_text(&result_content),
        )));
        return items;
    }

    let mut items = items;
    if tool_name == "task" {
        let updated = apply_batch_task_result(
            items.clone(),
            &tool_call_id,
            is_error,
            &result_details,
            true,
        );
        if updated.len() != items.len()
            || !updated
                .iter()
                .zip(items.iter())
                .all(|(a, b)| Arc::ptr_eq(a, b))
        {
            return updated;
        }
    }
    // The `wait` tool's own `tool_execution_end` is the other real carrier of per-subagent
    // completion: apply its `details.jobs[]` regardless of tool name, so a batch a `wait` call
    // actually waited for completes its rows instead of spinning forever.
    if let Some(wait_jobs) = jobs_from_details(&result_details) {
        items = apply_async_result_jobs(items, &wait_jobs);
    }

    let output = join_text(&result_content);
    let edit = build_edit_field(&tool_name, &result_details);
    let has_existing = items.iter().any(|item| {
        matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id)
    });
    if !has_existing {
        items.push(Arc::new(TranscriptItem::Tool {
            id: format!("tool-exec:{tool_call_id}"),
            tool_call_id,
            tool: tool_name,
            target: String::new(),
            status: if is_error {
                ToolStatus::Error
            } else {
                ToolStatus::Done
            },
            started_at: Some(now_ms()),
            duration_ms: Some(0),
            args: Value::Null,
            output: Some(output),
            diff: None,
            details: result_details_opt.clone(),
            edit,
            write: None,
        }));
        return items;
    }
    items
        .into_iter()
        .map(|mut item| {
            let is_target = matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id);
            if is_target {
                if let TranscriptItem::Tool { status, started_at, duration_ms, output: out, details: det, edit: e, .. } =
                    Arc::make_mut(&mut item)
                {
                    let new_duration = Some(started_at.map(|sa| (now_ms() - sa).max(0)).unwrap_or(0));
                    *status = if is_error { ToolStatus::Error } else { ToolStatus::Done };
                    *duration_ms = new_duration;
                    *out = Some(output.clone());
                    *det = result_details_opt.clone();
                    *e = edit.clone();
                }
            }
            item
        })
        .collect()
}

fn apply_prompt_result_notice(
    items: Vec<Arc<TranscriptItem>>,
    frame: &Value,
) -> Vec<Arc<TranscriptItem>> {
    let status = frame.get("status").and_then(Value::as_str).unwrap_or("");
    let mut items = items;
    match status {
        "error" => {
            let text = match frame.get("error") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Prompt failed.")
                    .to_string(),
                None => "Prompt failed.".to_string(),
            };
            let id = format!("notice-{}", items.len());
            items.push(Arc::new(TranscriptItem::Notice {
                id,
                level: NoticeLevel::Error,
                text,
            }));
            items
        }
        "aborted" => {
            let id = format!("notice-{}", items.len());
            items.push(Arc::new(TranscriptItem::Notice {
                id,
                level: NoticeLevel::Info,
                text: "Turn aborted.".to_string(),
            }));
            items
        }
        _ => items,
    }
}

/// Applies one live rpc-ui frame to the current transcript. Ignores every frame type not listed
/// in contracts/omp-usage.md "Frames Refract consumes" without throwing. `has_user_acted`
/// mirrors `SessionAgent`'s own tracking of whether the user has sent a prompt or slash command
/// yet in this process's lifetime -- `false` only for the window between process start and the
/// user's first send, exactly when OMP's unsolicited startup banner can arrive. Port of
/// `applyFrame`. `tool_execution_update` has no arm (falls to the wildcard below): `session::agent`
/// never routes it here (TS itself only acts on it for a `task` tool, and subagents are not
/// ported in this build -- performance finding, 2026-10-13).
fn apply_frame_items(
    items: Vec<Arc<TranscriptItem>>,
    frame: &Value,
    has_user_acted: bool,
) -> Vec<Arc<TranscriptItem>> {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "message_start" => {
            let message_id = frame.get("messageId").and_then(Value::as_str).unwrap_or("");
            match frame.get("message") {
                Some(message) => apply_message_snapshot(items, message_id, message, true),
                None => items,
            }
        }
        "message_update" => {
            let message_id = frame.get("messageId").and_then(Value::as_str).unwrap_or("");
            let partial = frame
                .get("assistantMessageEvent")
                .and_then(|e| e.get("partial"));
            match partial {
                Some(partial) if !partial.is_null() => {
                    apply_message_snapshot(items, message_id, partial, true)
                }
                _ => items,
            }
        }
        "message_end" => {
            let message_id = frame.get("messageId").and_then(Value::as_str).unwrap_or("");
            match frame.get("message") {
                Some(message) => apply_message_snapshot(items, message_id, message, false),
                None => items,
            }
        }
        "tool_execution_start" => apply_tool_execution_start(items, frame),
        "tool_execution_end" => apply_tool_execution_end(items, frame),
        "prompt_result" => apply_prompt_result_notice(items, frame),
        "command_output" => {
            let text = frame
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| frame.get("message").and_then(Value::as_str))
                .unwrap_or("");
            if text.is_empty() {
                return items;
            }
            let mut items = items;
            let id = if has_user_acted {
                format!("notice-{}", items.len())
            } else {
                format!("{STARTUP_NOTICE_PREFIX}{}", items.len())
            };
            items.push(Arc::new(TranscriptItem::Notice {
                id,
                level: NoticeLevel::Info,
                text: text.to_string(),
            }));
            items
        }
        "notice" => {
            let level_str = frame.get("level").and_then(Value::as_str).unwrap_or("info");
            let level = match level_str {
                "warning" => NoticeLevel::Warning,
                "error" => NoticeLevel::Error,
                _ => NoticeLevel::Info,
            };
            let message = frame
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut items = items;
            let id = if has_user_acted {
                format!("notice-{}", items.len())
            } else {
                format!("{STARTUP_NOTICE_PREFIX}{}", items.len())
            };
            items.push(Arc::new(TranscriptItem::Notice {
                id,
                level,
                text: message,
            }));
            items
        }
        _ => items,
    }
}

// ---------------------------------------------------------------------------
// History (`get_messages`) conversion (port of `attachToolResult`/`fromHistory`, lines 810-963)
// ---------------------------------------------------------------------------

fn attach_tool_result(
    items: Vec<Arc<TranscriptItem>>,
    message: &Value,
) -> Vec<Arc<TranscriptItem>> {
    let tool_call_id = message
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_name = message
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let is_error = message
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = content_parts(message);
    let details_opt = message.get("details").cloned();
    let details = details_opt.clone().unwrap_or(Value::Null);

    if HIDDEN_TOOLS.contains(&tool_name.as_str()) {
        if !is_error {
            return items;
        }
        let mut items = items;
        items.push(Arc::new(hidden_tool_failure_notice(
            &tool_call_id,
            &tool_name,
            &join_text(content),
        )));
        return items;
    }

    let mut items = items;
    if tool_name == "task" {
        let updated =
            apply_batch_task_result(items.clone(), &tool_call_id, is_error, &details, false);
        if updated.len() != items.len()
            || !updated
                .iter()
                .zip(items.iter())
                .all(|(a, b)| Arc::ptr_eq(a, b))
        {
            return updated;
        }
    }
    if let Some(wait_jobs) = jobs_from_details(&details) {
        items = apply_async_result_jobs(items, &wait_jobs);
    }

    let output = join_text(content);
    let edit = build_edit_field(&tool_name, &details);
    let has_existing = items.iter().any(|item| {
        matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id)
    });
    if !has_existing {
        items.push(Arc::new(TranscriptItem::Tool {
            id: format!("tool-hist:{tool_call_id}"),
            tool_call_id,
            tool: tool_name,
            target: String::new(),
            status: if is_error {
                ToolStatus::Error
            } else {
                ToolStatus::Done
            },
            started_at: None,
            duration_ms: None,
            args: Value::Null,
            output: Some(output),
            diff: None,
            details: details_opt.clone(),
            edit,
            write: None,
        }));
        return items;
    }
    items
        .into_iter()
        .map(|mut item| {
            let is_target = matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id);
            if is_target {
                if let TranscriptItem::Tool { status, output: out, details: det, edit: e, .. } = Arc::make_mut(&mut item) {
                    *status = if is_error { ToolStatus::Error } else { ToolStatus::Done };
                    *out = Some(output.clone());
                    *det = details_opt.clone();
                    *e = edit.clone();
                }
            }
            item
        })
        .collect()
}

/// Issue #510 slice 3: settles a `tool` row still `running` to `'interrupted'` when the caller
/// already knows the writing process is gone (`terminated_unexpectedly`), OR when a later `user`
/// item follows it in the transcript (a new user turn can never follow an unanswered tool call
/// within one healthy process life). Port of `settleInterruptedToolRows`. Returns `true` when any
/// row changed.
fn settle_interrupted_tool_rows_items(
    mut items: Vec<Arc<TranscriptItem>>,
    terminated_unexpectedly: bool,
) -> (Vec<Arc<TranscriptItem>>, bool) {
    let mut changed = false;
    let mut saw_later_user = false;
    for item in items.iter_mut().rev() {
        if matches!(item.as_ref(), TranscriptItem::User { .. }) {
            saw_later_user = true;
        }
        let settle = matches!(item.as_ref(), TranscriptItem::Tool { status, .. } if *status == ToolStatus::Running)
            && (terminated_unexpectedly || saw_later_user);
        if !settle {
            continue;
        }
        changed = true;
        if let TranscriptItem::Tool { status, .. } = Arc::make_mut(item) {
            *status = ToolStatus::Interrupted;
        }
    }
    (items, changed)
}

/// Builds the transcript items for a stored session's history (from `get_messages`), per
/// contracts/omp-usage.md "Message parts". Port of `fromHistory`'s own per-message loop --
/// deliberately NOT including the final `settleInterruptedToolRows` pass the TS function always
/// runs: this facade exposes that as a separate `TranscriptState::settle_interrupted_tool_rows`
/// method (see that struct's doc comment), since the Rust signature carries no
/// `terminated_unexpectedly` parameter to run it with yet. (`settleStaleSubagentRows` has no port
/// in this build: subagents are out of scope, see this file's own header comment, so there is no
/// `current_turn_keys`-scoped staleness to settle.)
fn items_from_history(messages: &[Value]) -> Vec<Arc<TranscriptItem>> {
    let mut items: Vec<Arc<TranscriptItem>> = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let message_id = format!("h{index}");
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "assistant" => {
                let parts = content_parts(message);
                let built = build_assistant_items(&message_id, parts, false, &items, false);
                items.extend(built.into_iter().map(Arc::new));
            }
            "user" => {
                let parts = content_parts(message);
                let text = join_text(parts);
                let at = as_timestamp(message, "timestamp").unwrap_or(0);
                items.push(Arc::new(TranscriptItem::User {
                    id: message_id,
                    text,
                    at,
                }));
            }
            "custom" => {
                let custom_type = message
                    .get("customType")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let content = message.get("content").and_then(Value::as_str).unwrap_or("");
                let details = message.get("details").cloned().unwrap_or(Value::Null);
                if let Some(async_result) = try_apply_async_result(&items, custom_type, &details) {
                    items = async_result;
                    continue;
                }
                if let Some(advisory_items) =
                    try_build_advisory_items(&message_id, custom_type, content)
                {
                    items.extend(advisory_items.into_iter().map(Arc::new));
                    continue;
                }
                if let Some(agent_message) =
                    try_build_agent_message(&message_id, custom_type, message)
                {
                    items.push(Arc::new(agent_message));
                    continue;
                }
                if message.get("display").and_then(Value::as_bool) == Some(true) {
                    items.push(Arc::new(TranscriptItem::Notice {
                        id: message_id,
                        level: NoticeLevel::Info,
                        text: content.to_string(),
                    }));
                }
            }
            "toolResult" => {
                items = attach_tool_result(items, message);
            }
            // `developer` and anything unrecognised: skip.
            _ => {}
        }
    }
    items
}

// ---------------------------------------------------------------------------
// `TranscriptState`: the mutable facade `session::agent` (Phase 3) drives
// ---------------------------------------------------------------------------

/// Owns one Session's current `TranscriptItem[]`, built from `get_messages` history
/// (`from_history`) and kept current by live rpc-ui frames (`apply_frame`). Mirrors
/// `SessionAgent.ts`'s own `runtime.transcript` field plus the piece of its state that feeds
/// `transcript.ts`'s functions: `has_user_acted` (`SessionAgent.hasUserActed`).
/// `terminated_unexpectedly` (`detectUnexpectedTermination`) has no equivalent constructor
/// parameter on this struct (the facade's `from_history` takes only `messages`) -- set it with
/// `set_terminated_unexpectedly` before calling `settle_interrupted_tool_rows`, which is how
/// `fromHistory` itself always finished on the TS side. `settleStaleSubagentRows`/
/// `current_turn_keys` have no port in this build: subagents are out of scope (see this file's
/// own header comment), so there is nothing for a durable-turn-marker staleness pass to settle.
///
/// Items are stored behind `Arc` (performance finding, 2026-10-13): `apply_frame` and every
/// helper it calls only ever wrap a genuinely new/changed value in a fresh `Arc`
/// (`Arc::make_mut`'s own clone-on-write, or a freshly built item), leaving every untouched
/// item's `Arc` pointer unchanged. That makes `items().to_vec()` (done once per frame by
/// `session::agent` to diff against) O(n) pointer bumps instead of a full deep copy, and lets
/// `diff.rs`'s `diff_transcript` tell "changed" from "unchanged" with `Arc::ptr_eq` instead of a
/// full value compare -- so per-frame cost is proportional to what changed, not to the whole
/// transcript.
pub struct TranscriptState {
    items: Vec<Arc<TranscriptItem>>,
    has_user_acted: bool,
    terminated_unexpectedly: bool,
}

impl TranscriptState {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            has_user_acted: false,
            terminated_unexpectedly: false,
        }
    }

    /// Port of the `get_messages` history conversion (`fromHistory`'s per-message loop; see
    /// `items_from_history`'s doc comment for why the trailing settle pass is not run here).
    pub fn from_history(messages: &[Value]) -> Self {
        Self {
            items: items_from_history(messages),
            has_user_acted: false,
            terminated_unexpectedly: false,
        }
    }

    /// Finalizes every still-live row (a still-`running` tool/subagent call becomes `error`,
    /// streaming assistant-text/thinking stops `streaming`) via `diff::finalize_live_transcript`.
    /// For `SessionAgent::handle_exit`'s own use: a crash or `stop()` mid-turn must not leave a
    /// row spinning forever in the UI (code-review finding, 2026-10-13; TS calls this
    /// `finalizeLiveItems`, `SessionAgent.ts:1379`).
    pub fn finalize_live_items(&mut self) {
        let items = std::mem::take(&mut self.items);
        self.items = finalize_live_transcript(items);
    }

    /// Builds history-based items, then merges the Session's current (still-live) items on top
    /// via `diff::merge_history_with_live`, keeping `has_user_acted`/`terminated_unexpectedly`
    /// unchanged across the swap. Port of `mergeLiveTranscript` (code-review finding,
    /// 2026-10-13: `launch()` used to replace the transcript outright instead of merging,
    /// silently dropping any notice/request/in-flight item a live frame appended while the
    /// history fetch was in flight).
    pub fn merge_from_history(&mut self, messages: &[Value]) {
        let history_items = items_from_history(messages);
        self.items = merge_history_with_live(&history_items, &self.items);
    }

    /// Applies one live rpc-ui frame (port of `applyFrame`), mutating `self.items` in place so
    /// that only the items the frame actually touched get a new `Arc` -- everything else keeps
    /// its identity (see this struct's own doc comment).
    pub fn apply_frame(&mut self, frame: &Value) {
        let items = std::mem::take(&mut self.items);
        self.items = apply_frame_items(items, frame, self.has_user_acted);
    }

    pub fn items(&self) -> &[Arc<TranscriptItem>] {
        &self.items
    }

    /// Replaces the item with the same `id` in place, or appends it. Port of
    /// `SessionAgent.ts`'s private `upsertTranscriptItem` (used there for `request` rows around
    /// approval dialogs, and for ad hoc `notice`/`agent-message` items built outside a frame).
    pub fn upsert_item(&mut self, item: TranscriptItem) {
        match self
            .items
            .iter()
            .position(|existing| existing.id() == item.id())
        {
            Some(pos) => self.items[pos] = Arc::new(item),
            None => self.items.push(Arc::new(item)),
        }
    }

    /// Marks that the user has sent a prompt or slash command at least once in this process's
    /// lifetime (`SessionAgent.hasUserActed`); one-directional, matching the TS field (only ever
    /// flips false -> true).
    pub fn mark_user_acted(&mut self) {
        self.has_user_acted = true;
    }

    /// Port of `settleInterruptedToolRows`, using the flag set by `set_terminated_unexpectedly`.
    /// Returns `true` when any row changed.
    pub fn settle_interrupted_tool_rows(&mut self) -> bool {
        let (next, changed) =
            settle_interrupted_tool_rows_items(self.items.clone(), self.terminated_unexpectedly);
        self.items = next;
        changed
    }
}

impl Default for TranscriptState {
    fn default() -> Self {
        Self::new()
    }
}
