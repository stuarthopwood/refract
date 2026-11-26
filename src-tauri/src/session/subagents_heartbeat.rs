// Heartbeat-derived summary fields (`filesTouched`, `recentSteps`) for `session::subagents` (#1925),
// split out to keep `subagents_progress` under the 600-line cap.

use serde_json::{json, Value};

use super::SummaryEntry;

/// Caps for the heartbeat-derived summary fields.
const MAX_FILES_TOUCHED: usize = 50;
const MAX_RECENT_STEPS: usize = 5;
/// Every heartbeat string is cut to this, because each one rides along in every `subagents:update`.
const MAX_FIELD_CHARS: usize = 300;

/// One recent tool call kept on a summary for the "what is it doing" line.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct RecentStep {
    tool: String,
    intent: Option<String>,
    target: Option<String>,
    is_error: Option<bool>,
    end_ms: Option<i64>,
}

/// Cuts on a char boundary, never mid-codepoint.
fn clamp(text: &str) -> String {
    text.chars().take(MAX_FIELD_CHARS).collect()
}

/// The call's path: `args` is a preview string today, but an object with a `path` key is also read.
fn tool_path(entry: &Value) -> Option<String> {
    let args = entry.get("args")?;
    let raw = match args {
        Value::String(text) => text.as_str(),
        Value::Object(_) => args.get("path").and_then(Value::as_str)?,
        _ => return None,
    };
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| clamp(trimmed))
}

fn recent_step(entry: &Value) -> Option<RecentStep> {
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(clamp);
    Some(RecentStep {
        tool: text("tool")?,
        intent: text("intent"),
        target: tool_path(entry),
        is_error: entry.get("isError").and_then(Value::as_bool),
        end_ms: entry.get("endMs").and_then(Value::as_i64),
    })
}

/// The wire shape of one step; absent fields are omitted, never null.
pub(super) fn step_value(step: &RecentStep) -> Value {
    let mut obj = json!({ "tool": step.tool });
    if let Some(intent) = &step.intent {
        obj["intent"] = json!(intent);
    }
    if let Some(target) = &step.target {
        obj["target"] = json!(target);
    }
    if let Some(is_error) = step.is_error {
        obj["isError"] = json!(is_error);
    }
    if let Some(end_ms) = step.end_ms {
        obj["endMs"] = json!(end_ms);
    }
    obj
}

/// Folds one heartbeat into the summary: new written or edited paths (deduplicated, capped,
/// first-seen order) and the latest steps. A frame without `recentTools` changes nothing.
/// Returns whether the summary changed, so the caller emits only then.
pub(super) fn accumulate_heartbeat(entry: &mut SummaryEntry, progress: &Value) -> bool {
    let Some(tools) = progress.get("recentTools").and_then(Value::as_array) else {
        return false;
    };
    let mut changed = false;
    for tool in tools {
        if !matches!(
            tool.get("tool").and_then(Value::as_str),
            Some("write" | "edit")
        ) {
            continue;
        }
        let Some(path) = tool_path(tool) else {
            continue;
        };
        if entry.files_touched.len() < MAX_FILES_TOUCHED && !entry.files_touched.contains(&path) {
            entry.files_touched.push(path);
            changed = true;
        }
    }
    let mut steps: Vec<RecentStep> = tools.iter().filter_map(recent_step).collect();
    steps.drain(..steps.len().saturating_sub(MAX_RECENT_STEPS));
    if !steps.is_empty() && steps != entry.recent_steps {
        entry.recent_steps = steps;
        changed = true;
    }
    changed
}

#[cfg(test)]
#[path = "subagents_heartbeat.test.rs"]
mod tests;
