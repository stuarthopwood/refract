// Current-work banner state (#687), split out of `readout` for file size (#806).
use serde_json::{json, Value};

use super::super::agent::SessionAgent;
use super::schedule_readout_update;

#[path = "readout_activity_emit.rs"]
mod readout_activity_emit;
pub use readout_activity_emit::current_activity;
pub(super) use readout_activity_emit::emit_activity;

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    if !ActivityState::is_activity_frame(frame_type) {
        return;
    }
    let changed = agent
        .with_readout_state(|s| s.activity.apply_frame(frame_type, frame))
        .await;
    if changed {
        schedule_readout_update(agent).await;
    }
}

/// The renderer caps agent-authored text at 160 characters; this only bounds the payload.
const MAX_TEXT_CHARS: usize = 400;

#[derive(Debug, Clone, Default)]
pub(super) struct ActivityState {
    latest_intent: Option<String>,
    latest_tool: Option<(String, Option<String>)>,
    retry: Option<(i64, i64)>,
    compacting: bool,
    /// Throttle bookkeeping; survives `reset`.
    emit: readout_activity_emit::EmitState,
}

fn bounded(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(MAX_TEXT_CHARS).collect())
    }
}

/// A path-like argument, so the banner can say "Reading ChatPane.tsx"; never a command line.
fn target_of(args: &Value) -> Option<String> {
    ["path", "file_path", "filePath", "file"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .and_then(bounded)
}

impl ActivityState {
    /// Frame types `apply_frame` reacts to; others skip the state lock.
    pub(super) fn is_activity_frame(frame_type: &str) -> bool {
        matches!(
            frame_type,
            "tool_execution_start"
                | "auto_retry_start"
                | "auto_retry_end"
                | "auto_compaction_start"
                | "auto_compaction_end"
                | "manual_compaction_start"
                | "manual_compaction_end"
                | "agent_start"
                | "session_settled"
                | "prompt_result"
        )
    }

    /// Applies one decoded frame; `true` when the retained activity changed.
    pub(super) fn apply_frame(&mut self, frame_type: &str, frame: &Value) -> bool {
        match frame_type {
            "tool_execution_start" => {
                let Some(name) = frame.get("toolName").and_then(Value::as_str) else {
                    return false;
                };
                let args = frame.get("args").unwrap_or(&Value::Null);
                // Subagent progress puts `intent` in args, not on the frame; accept either.
                self.latest_intent = frame
                    .get("intent")
                    .or_else(|| args.get("intent"))
                    .and_then(Value::as_str)
                    .and_then(bounded);
                self.latest_tool =
                    Some((name.chars().take(MAX_TEXT_CHARS).collect(), target_of(args)));
                true
            }
            "auto_retry_start" => {
                let attempt = frame.get("attempt").and_then(Value::as_i64);
                let max = frame.get("maxAttempts").and_then(Value::as_i64);
                match (attempt, max) {
                    (Some(attempt), Some(max)) => {
                        self.retry = Some((attempt, max));
                        true
                    }
                    _ => false,
                }
            }
            "auto_retry_end" => std::mem::take(&mut self.retry).is_some(),
            "auto_compaction_start" | "manual_compaction_start" => {
                !std::mem::replace(&mut self.compacting, true)
            }
            "auto_compaction_end" | "manual_compaction_end" => {
                std::mem::replace(&mut self.compacting, false)
            }
            "agent_start" | "session_settled" => self.reset(),
            "prompt_result"
                if frame.get("sessionSettled").and_then(Value::as_bool) == Some(true) =>
            {
                self.reset()
            }
            _ => false,
        }
    }

    /// Turn boundary or process exit: nothing from the previous turn may linger.
    pub(super) fn reset(&mut self) -> bool {
        let changed = self.latest_intent.is_some()
            || self.latest_tool.is_some()
            || self.retry.is_some()
            || self.compacting;
        *self = Self {
            emit: std::mem::take(&mut self.emit),
            ..Self::default()
        };
        changed
    }

    /// Adds the four banner fields to an assembled readout wire value.
    pub(super) fn write_into(&self, readout: &mut Value) {
        readout["latestIntent"] = self
            .latest_intent
            .clone()
            .map_or(Value::Null, Value::String);
        readout["latestTool"] = self.latest_tool.as_ref().map_or(
            Value::Null,
            |(name, target)| json!({ "name": name, "target": target }),
        );
        readout["retry"] = self.retry.map_or(
            Value::Null,
            |(attempt, max)| json!({ "attempt": attempt, "maxAttempts": max }),
        );
        readout["compacting"] = Value::Bool(self.compacting);
    }
}
