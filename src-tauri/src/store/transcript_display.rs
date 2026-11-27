// `transcriptDisplay` object and its lazy-correction parse; child module of `settings.rs` (#806).
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Where tool rows show their target: hidden, in a tooltip on the verb, or in the row (#1758).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolTargets {
    Hide,
    #[default]
    Hover,
    Show,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptDisplaySettings {
    pub thinking: bool,
    #[serde(rename = "toolCalls")]
    pub tool_calls: bool,
    /// Show the raw tool id on tool rows; default `false` (#469).
    #[serde(rename = "toolNames", default)]
    pub tool_names: bool,
    /// Open answered Ask rows in the transcript; default `true` (#1747).
    #[serde(
        rename = "expandAnsweredAsks",
        default = "default_expand_answered_asks"
    )]
    pub expand_answered_asks: bool,
    /// Where tool rows show their target; default `hover` (#1758).
    #[serde(rename = "toolTargets", default)]
    pub tool_targets: ToolTargets,
}

fn default_expand_answered_asks() -> bool {
    true
}

pub(super) fn parse(object: &Map<String, Value>) -> TranscriptDisplaySettings {
    let raw = object.get("transcriptDisplay").and_then(Value::as_object);
    let flag = |key: &str, default: bool| {
        raw.and_then(|o| o.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(default)
    };
    // An unknown or malformed value falls back to the default rather than failing the whole load.
    let tool_targets = raw
        .and_then(|o| o.get("toolTargets"))
        .and_then(|v| serde_json::from_value::<ToolTargets>(v.clone()).ok())
        .unwrap_or_default();
    TranscriptDisplaySettings {
        thinking: flag("thinking", true),
        tool_calls: flag("toolCalls", true),
        tool_names: flag("toolNames", false),
        expand_answered_asks: flag("expandAnsweredAsks", true),
        tool_targets,
    }
}
