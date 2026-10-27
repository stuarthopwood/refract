// Issue #457/#469: the `transcriptDisplay` object and its lazy-correction parse. A child module of
// `settings.rs` (not inline there) to keep that file under this build's 600-line cap (issue
// #806), the same reason `agent_stopped_bar.rs` was split out. Unchanged from its old inline home.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptDisplaySettings {
    pub thinking: bool,
    #[serde(rename = "toolCalls")]
    pub tool_calls: bool,
    /// Issue #469: show the raw tool id on tool rows. Default `false`.
    #[serde(rename = "toolNames", default)]
    pub tool_names: bool,
}

pub(super) fn parse(object: &Map<String, Value>) -> TranscriptDisplaySettings {
    let raw = object.get("transcriptDisplay").and_then(Value::as_object);
    let flag = |key: &str, default: bool| {
        raw.and_then(|o| o.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(default)
    };
    TranscriptDisplaySettings {
        thinking: flag("thinking", true),
        tool_calls: flag("toolCalls", true),
        tool_names: flag("toolNames", false),
    }
}
