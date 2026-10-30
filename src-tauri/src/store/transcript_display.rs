// `transcriptDisplay` object and its lazy-correction parse; child module of `settings.rs` (#806).
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptDisplaySettings {
    pub thinking: bool,
    #[serde(rename = "toolCalls")]
    pub tool_calls: bool,
    /// Show the raw tool id on tool rows; default `false` (#469).
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
