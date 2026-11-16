// Builds renderer-facing transcript items from OMP history and live rpc-ui frames. Pure: no I/O.
// Fields are read defensively by name (untyped wire); change detection compares by value.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::diff::{finalize_live_transcript, merge_history_with_live, SubagentFinalizeCause};

mod tool_intent;
use tool_intent::{read_history_intent, read_live_intent};
pub mod subagent_items;
use subagent_items::{
    apply_async_result_jobs, apply_batch_task_result, build_message_subagent_items,
    hidden_tool_failure_notice, jobs_from_details, read_batch_context, read_task_specs,
    try_apply_async_result, upsert_subagent_items,
};
mod notice_prefixes;
use notice_prefixes::{COMMAND_OUTPUT_NOTICE_PREFIX, STARTUP_NOTICE_PREFIX};
mod warning_collapse;
use warning_collapse::collapse_repeated_warning;
pub mod file_attachment_markers;
use file_attachment_markers::FileAttachmentRef;
mod user_images;
use user_images::ImageRef;
mod message_source;
pub use message_source::MessageSource;
mod agent_message;
use agent_message::try_build_agent_message;
mod skill_prompt;
use skill_prompt::try_build_skill_prompt;
mod turn_error;
use turn_error::{build_turn_error_item, current_turn_has_error};

/// One renderer-facing transcript row, wire-identical to `model.ts`'s `TranscriptItem`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TranscriptItem {
    User {
        id: String,
        text: String,
        at: i64,
        // Files and folders attached to the message (#926).
        #[serde(
            rename = "fileAttachments",
            default,
            skip_serializing_if = "Vec::is_empty"
        )]
        file_attachments: Vec<FileAttachmentRef>,
        // Image ids only, never bytes (#513).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        // Set when another Session sent the turn (#1858).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<MessageSource>,
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
        /// Unset args serialize as absent, not `null`.
        #[serde(default, skip_serializing_if = "Value::is_null")]
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// Never set here; the renderer computes it from `edit`/`write`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edit: Option<EditField>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        write: Option<WriteField>,
        /// The model's one-line intent (#469).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intent: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Subagent {
        id: String,
        tool_call_id: String,
        spec_index: u32,
        name: String,
        task: String,
        /// The batch `task()` call's shared `context`; its first line names the Stage (#941).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        status: SubagentStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_id: Option<String>,
        /// The owning assistant message's id; the renderer groups Stage membership by it (#563).
        /// Empty briefly between `tool_execution_start` and the message snapshot echoing the call.
        #[serde(default)]
        message_id: String,
        /// Never serialized: set once a real async-result job has resolved this row, so a
        /// later job with the same `job_id`/label never re-matches it (#989).
        #[serde(skip)]
        async_settled: bool,
    },
    #[serde(rename = "agent-message", rename_all = "camelCase")]
    AgentMessage {
        id: String,
        from: String,
        to: String,
        text: String,
        at: i64,
        // #838: OMP's `details.fromParent`/`replyTo`, passed through (`agent_message.rs`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_parent: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
    },
    /// #1817: a `/skill:<name>` prompt (`skill_prompt.rs`); `text` is the untrusted injected skill text.
    #[serde(rename = "skill-prompt", rename_all = "camelCase")]
    SkillPrompt {
        id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        text: String,
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
    /// #1284: the end-of-turn model error (`turn_error.rs`); `text` is OMP's untrusted `errorMessage`.
    TurnError { id: String, text: String },
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
            | TranscriptItem::SkillPrompt { id, .. }
            | TranscriptItem::Advisory { id, .. }
            | TranscriptItem::Request { id, .. }
            | TranscriptItem::Notice { id, .. }
            | TranscriptItem::TurnError { id, .. } => id,
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
    Cancelled,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubagentStatus {
    Running,
    Done,
    Error,
    Cancelled, // #563 decision 15: split out of `Error` -- cancel/abort is not a failure.
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

/// From an `edit` tool's result details; the renderer builds the unified diff.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditField {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

/// From a `write` tool's args; the renderer diffs it against a cached prior read/edit.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WriteField {
    pub path: String,
    pub content: String,
}

const MAX_TARGET_LENGTH: usize = 200;
const SUBAGENT_NAME_LENGTH: usize = 60;

/// Agent bookkeeping tools that never become a `tool` item (`HIDDEN_TOOLS` in `model.ts`).
const HIDDEN_TOOLS: &[&str] = &["todo"];

const ASYNC_RESULT_CUSTOM_TYPE: &str = "async-result";
const ADVISORY_CUSTOM_TYPE: &str = "advisor";

fn is_advisory_severity(value: &str) -> bool {
    matches!(value, "nit" | "concern" | "blocker")
}

/// Mirrors `KNOWN_FRAME_TYPES` in `frames.ts`: every frame type OMP can emit.
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

/// Reads a JSON field as an epoch-millisecond timestamp: any JSON number, not only an exact `i64`.
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

/// First string argument. `serde_json::Map` iterates key-sorted, not in insertion order, so
/// for uncommon tools the picked `target` label can differ from the TS build.
fn first_string_arg(args: &Value) -> String {
    if let Some(map) = args.as_object() {
        // #469: the intent (`i`/`intent`) is the row's label, never its target.
        for (key, value) in map {
            if key == "i" || key == "intent" {
                continue;
            }
            if let Some(s) = value.as_str() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// Hand-rolled `/\[(.+?)#[0-9A-Fa-f]{4}\]/` (no `regex` dependency): shortest run before `#hhhh]`.
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

/// A numeric character reference must be a real Unicode scalar: at most U+10FFFF, no surrogate.
fn is_valid_xml_code_point(code_point: u32) -> bool {
    code_point <= 0x10ffff && !(0xd800..=0xdfff).contains(&code_point)
}

/// Decodes the five XML entities and numeric references; anything else is left untouched.
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

/// Decodes one entity at `&` in `rest`: the text and bytes consumed, or `None` (caller keeps `&`).
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

/// Hand-rolled scanner for `name="value"`/`name='value'` pairs over one tag's attribute list.
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

/// Reads an attribute list into a map; a duplicate name is a parse failure (`None`).
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

/// One `<advisory ...>` opening tag's attribute list and the byte offset past its `>`.
struct OpenTagMatch {
    attr_source: String,
    body_start: usize,
}

/// Hand-rolled matcher for an `<advisory ...>` opening tag only (no body), scanning from `from`.
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

/// Parses every `<advisory ...>note</advisory>` element into an item. One forward closing-tag
/// search per open tag keeps the scan linear even with many unclosed tags.
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

/// Parsed `advisory` items for a `customType: 'advisor'` message, else `None`. One yielding no
/// well-formed element becomes a plain `notice`, never dropped.
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

/// Builds items for one assistant `content[]` snapshot. `capture_timing` is `false` for history,
/// where a load-time `now_ms()` stamp would show a meaningless duration.
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
                        let context = read_batch_context(&arguments);
                        result.extend(build_message_subagent_items(
                            existing_items,
                            &part_id,
                            &specs,
                            context.as_deref(),
                            message_id,
                            capture_timing,
                        ));
                        continue;
                    }
                }
                let existing = existing_for_message.iter().find(
                    |item| matches!(item, TranscriptItem::Tool { id: tid, .. } if *tid == id),
                );
                let target = extract_target(&name, &arguments);
                let write = build_write_field(&name, &arguments);
                let intent = read_history_intent(&arguments);
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
                        intent: old_intent,
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
                        intent: intent.or_else(|| old_intent.clone()),
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
                        intent,
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

/// Replaces every item of `message_id` (or `id:index`) in place, appending for a new message.
/// Also strips items whose id is in `replacement` (a `subagent` item is keyed by `tool_call_id`).
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
    // Every item before `insert_at` is a non-match and survives, so the index is still valid.
    let insert_at = insert_at.min(without_message.len());
    let mut result = without_message;
    let tail = result.split_off(insert_at);
    result.extend(replacement);
    result.extend(tail);
    result
}

/// Borrows `content[]` rather than cloning: this runs once per streamed token chunk.
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
            let mut built = build_assistant_items(message_id, parts, streaming, &items, true);
            if !streaming {
                built.extend(build_turn_error_item(message_id, message));
            }
            replace_message_items(items, message_id, built.into_iter().map(Arc::new).collect())
        }
        "user" => {
            let parts = content_parts(message);
            let text = join_text(parts);
            let at = as_timestamp(message, "timestamp").unwrap_or_else(now_ms);
            // #926: `build_user_item` strips any `[[refract-attachments]]` section first.
            replace_message_items(
                items,
                message_id,
                vec![Arc::new(file_attachment_markers::build_user_item(
                    message_id.to_string(),
                    text,
                    at,
                    parts,
                ))],
            )
        }
        "custom" => {
            let custom_type = message
                .get("customType")
                .and_then(Value::as_str)
                .unwrap_or("");
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            let details = message.get("details").cloned().unwrap_or(Value::Null);
            // Live async-result messages always set `display: true`; without this a `message_start`
            // would leave a permanent Notice row `message_end` never removes (#989).
            if custom_type == ASYNC_RESULT_CUSTOM_TYPE {
                if !streaming {
                    if let Some(async_result) =
                        try_apply_async_result(&items, custom_type, &details)
                    {
                        return async_result;
                    }
                }
                return items;
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
            if let Some(skill_prompt) = try_build_skill_prompt(message_id, custom_type, message) {
                return replace_message_items(items, message_id, vec![Arc::new(skill_prompt)]);
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
        // `developer` is hidden and `toolResult` output comes from `tool_execution_end`; the
        // wildcard covers both (clippy `wildcard_in_or_patterns`).
        _ => items,
    }
}

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
            let context = read_batch_context(&args);
            return upsert_subagent_items(items, &tool_call_id, &specs, context.as_deref());
        }
    }
    let target = extract_target(&tool_name, &args);
    let write = build_write_field(&tool_name, &args);
    let intent = read_live_intent(frame);
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
            intent,
        }));
        return items;
    }
    items
        .into_iter()
        .map(|mut item| {
            let is_target = matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id);
            if is_target {
                if let TranscriptItem::Tool { tool, target: t, status, started_at, args: a, write: old_write, intent: old_intent, .. } =
                    Arc::make_mut(&mut item)
                {
                    let merged_write = write.clone().or_else(|| old_write.clone());
                    if old_intent.is_none() {
                        *old_intent = intent.clone();
                    }
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
    turn_abort_requested: bool,
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
    let result_details = result.get("details").cloned();

    if HIDDEN_TOOLS.contains(&tool_name.as_str()) {
        if !is_error || turn_abort_requested {
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
            result_details.as_ref().unwrap_or(&Value::Null),
            true,
            turn_abort_requested,
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
    // `wait` also carries per-subagent completion: apply its `details.jobs[]` so waited rows finish.
    if let Some(wait_jobs) = jobs_from_details(result_details.as_ref().unwrap_or(&Value::Null)) {
        items = apply_async_result_jobs(items, &wait_jobs);
    }

    let output = join_text(&result_content);
    let edit = build_edit_field(&tool_name, result_details.as_ref().unwrap_or(&Value::Null));
    let has_existing = items.iter().any(|item| {
        matches!(item.as_ref(), TranscriptItem::Tool { tool_call_id: t, .. } if *t == tool_call_id)
    });
    if !has_existing {
        let status = match (is_error, turn_abort_requested) {
            (false, _) => ToolStatus::Done,
            (true, true) => ToolStatus::Cancelled,
            (true, false) => ToolStatus::Error,
        };
        items.push(Arc::new(TranscriptItem::Tool {
            id: format!("tool-exec:{tool_call_id}"),
            tool_call_id,
            tool: tool_name,
            target: String::new(),
            status,
            started_at: Some(now_ms()),
            duration_ms: Some(0),
            args: Value::Null,
            output: Some(output),
            diff: None,
            details: result_details.clone(),
            edit,
            write: None,
            intent: None,
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
                    *status = if !is_error { ToolStatus::Done } else if turn_abort_requested && matches!(status, ToolStatus::Running) { ToolStatus::Cancelled } else { ToolStatus::Error };
                    *duration_ms = new_duration;
                    *out = Some(output.clone());
                    *det = result_details.clone();
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
            if current_turn_has_error(&items) {
                return items;
            }
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
                text: "Turn stopped.".to_string(),
            }));
            items
        }
        _ => items,
    }
}

/// Applies one live rpc-ui frame; unlisted frame types are ignored. `has_user_acted` is `false`
/// only until the first user send, when OMP's unsolicited startup banner can arrive.
fn apply_frame_items(
    items: Vec<Arc<TranscriptItem>>,
    frame: &Value,
    has_user_acted: bool,
    turn_abort_requested: bool,
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
        "tool_execution_end" => apply_tool_execution_end(items, frame, turn_abort_requested),
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
                format!("{COMMAND_OUTPUT_NOTICE_PREFIX}{}", items.len())
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
            if level == NoticeLevel::Warning && collapse_repeated_warning(&mut items, &message) {
                return items;
            }
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
    let details = message.get("details").cloned();
    let details_ref = details.as_ref().unwrap_or(&Value::Null);
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
        let updated = // issue #911: history replay has no live abort signal, always `false`
            apply_batch_task_result(items.clone(), &tool_call_id, is_error, details_ref, false, false);
        if updated.len() != items.len()
            || !updated
                .iter()
                .zip(items.iter())
                .all(|(a, b)| Arc::ptr_eq(a, b))
        {
            return updated;
        }
    }
    if let Some(wait_jobs) = jobs_from_details(details_ref) {
        items = apply_async_result_jobs(items, &wait_jobs);
    }

    let output = join_text(content);
    let edit = build_edit_field(&tool_name, details_ref);
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
            details: details.clone(),
            edit,
            write: None,
            intent: None,
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
                    *det = details.clone();
                    *e = edit.clone();
                }
            }
            item
        })
        .collect()
}

/// Settles leftover history subagents to Done, and a `running` tool row to `'interrupted'` when the
/// process died or a later `user` item follows it (#510). Returns `true` when any item changed.
fn settle_interrupted_tool_rows_items(
    mut items: Vec<Arc<TranscriptItem>>,
    terminated_unexpectedly: bool,
) -> (Vec<Arc<TranscriptItem>>, bool) {
    let mut changed = subagent_items::settle_unsettled_history_subagents(&mut items);
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

/// Builds items from stored `get_messages` history. It omits the final interrupted-row settle
/// pass; `TranscriptState::settle_interrupted_tool_rows` runs that separately.
fn items_from_history(messages: &[Value]) -> Vec<Arc<TranscriptItem>> {
    let mut items: Vec<Arc<TranscriptItem>> = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let message_id = format!("h{index}");
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "assistant" => {
                let parts = content_parts(message);
                let mut built = build_assistant_items(&message_id, parts, false, &items, false);
                built.extend(build_turn_error_item(&message_id, message));
                items.extend(built.into_iter().map(Arc::new));
            }
            "user" => {
                let parts = content_parts(message);
                let text = join_text(parts);
                let at = as_timestamp(message, "timestamp").unwrap_or(0);
                items.push(Arc::new(file_attachment_markers::build_user_item(
                    message_id, text, at, parts,
                )));
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
                if let Some(skill_prompt) =
                    try_build_skill_prompt(&message_id, custom_type, message)
                {
                    items.push(Arc::new(skill_prompt));
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

/// One Session's current `TranscriptItem[]`; items sit behind `Arc` so only changed ones get a
/// fresh pointer and `diff_transcript` can use `Arc::ptr_eq`.
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

    /// Converts `get_messages` history (the trailing settle pass is not run here).
    pub fn from_history(messages: &[Value]) -> Self {
        Self {
            items: items_from_history(messages),
            has_user_acted: false,
            terminated_unexpectedly: false,
        }
    }

    /// Finalizes every still-live tool and subagent row per `cause` (#563, #911).
    pub fn finalize_live_items(&mut self, cause: SubagentFinalizeCause) {
        let items = std::mem::take(&mut self.items);
        self.items = finalize_live_transcript(items, cause);
    }

    /// Settles history items BEFORE merging onto live ones, or a running live row could be marked
    /// `interrupted`. `terminated_unexpectedly` is one-shot, never written to `self`.
    pub fn merge_from_history(&mut self, messages: &[Value], terminated_unexpectedly: bool) {
        let history_items = items_from_history(messages);
        let (settled, _) =
            settle_interrupted_tool_rows_items(history_items, terminated_unexpectedly);
        self.items = merge_history_with_live(&settled, &self.items);
    }

    /// Applies one live frame in place; only touched items get a new `Arc`.
    /// `turn_abort_requested` is `session::agent`'s per-turn flag (#911).
    pub fn apply_frame(&mut self, frame: &Value, turn_abort_requested: bool) {
        let items = std::mem::take(&mut self.items);
        self.items = apply_frame_items(items, frame, self.has_user_acted, turn_abort_requested);
    }

    pub fn items(&self) -> &[Arc<TranscriptItem>] {
        &self.items
    }

    /// Cheap (Arc-sharing) copy to diff against after a mutation.
    pub fn snapshot(&self) -> Vec<Arc<TranscriptItem>> {
        self.items.clone()
    }

    /// Consumes the state, handing over the items without a copy.
    pub fn into_items(self) -> Vec<Arc<TranscriptItem>> {
        self.items
    }

    /// Replaces the item with the same `id` in place, or appends it.
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
    /// Marks that the user has sent a prompt/slash command; one-directional.
    pub fn mark_user_acted(&mut self) {
        self.has_user_acted = true;
    }
    /// Sets the flag `settle_interrupted_tool_rows` reads (full rebuilds only; launch merges settle
    /// via `merge_from_history`'s own parameter).
    pub fn set_terminated_unexpectedly(&mut self, value: bool) {
        self.terminated_unexpectedly = value;
    }
    /// Settles interrupted tool rows using the `set_terminated_unexpectedly` flag; `true` if any changed.
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
