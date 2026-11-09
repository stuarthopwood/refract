// Read-only views for Settings: where compaction fires per model, and which keys a Project config overrides.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::values::{is_key, ValueMap};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub model: String,
    pub context_window: i64,
    pub threshold_percent: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_threshold: Option<Value>,
    pub trigger_tokens: i64,
}

/// Resolves one model's trigger. A per-model entry wins: `"f<n>"` is fixed tokens, `"<n>%"` or a
/// number up to 99 is a percent of the window, any larger number is tokens.
pub fn trigger_for(model: &str, window: i64, values: &ValueMap) -> Trigger {
    let percent = values
        .get("compaction.thresholdPercent")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let entry = values
        .get("compaction.modelThresholds")
        .and_then(|v| v.get(model))
        .cloned();
    let of_window = |p: i64| window.saturating_mul(p) / 100;
    let tokens = match &entry {
        Some(Value::String(s)) if s.starts_with('f') => s[1..].parse().unwrap_or(0),
        Some(Value::String(s)) => of_window(s.trim_end_matches('%').parse().unwrap_or(0)),
        Some(Value::Number(n)) => match n.as_i64().unwrap_or(0) {
            p @ 1..=99 => of_window(p),
            t => t,
        },
        _ if percent > 0 => of_window(percent),
        _ => 0,
    };
    Trigger {
        model: model.to_string(),
        context_window: window,
        threshold_percent: percent,
        model_threshold: entry,
        trigger_tokens: tokens,
    }
}

/// Largest project config read; a bigger file is not a plausible settings file.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// Token guard keys written in a project's `.omp/config.yml`, as dotted paths. Reads only; a missing
/// or unreadable file means no overrides.
pub async fn project_overrides(project_path: &Path) -> Vec<String> {
    use tokio::io::AsyncReadExt;
    let Ok(file) = tokio::fs::File::open(project_path.join(".omp").join("config.yml")).await
    else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_CONFIG_BYTES)
        .read_to_end(&mut bytes)
        .await
        .is_err()
    {
        return Vec::new();
    }
    overrides_in(&String::from_utf8_lossy(&bytes))
}

fn overrides_in(text: &str) -> Vec<String> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut found = Vec::new();
    for line in text.lines() {
        let body = line.trim_start();
        if body.is_empty() || body.starts_with('#') || body.starts_with('-') {
            continue;
        }
        let Some((key, _)) = body.split_once(':') else {
            continue;
        };
        let indent = line.len() - body.len();
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let key = key.trim().trim_matches('"').trim_matches('\'');
        let dotted = stack
            .iter()
            .map(|(_, k)| k.as_str())
            .chain([key])
            .collect::<Vec<_>>()
            .join(".");
        if is_key(&dotted) && !found.contains(&dotted) {
            found.push(dotted.clone());
        }
        stack.push((indent, key.to_string()));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn values(percent: i64, thresholds: Value) -> ValueMap {
        let mut v = ValueMap::new();
        v.insert("compaction.thresholdPercent".into(), json!(percent));
        v.insert("compaction.modelThresholds".into(), thresholds);
        v
    }

    #[test]
    fn per_model_entry_beats_global_percent() {
        let v = values(70, json!({ "a/b": "f50000", "c/d": "80%", "e/f": 120000 }));
        assert_eq!(trigger_for("a/b", 200_000, &v).trigger_tokens, 50_000);
        assert_eq!(trigger_for("c/d", 200_000, &v).trigger_tokens, 160_000);
        assert_eq!(trigger_for("e/f", 200_000, &v).trigger_tokens, 120_000);
        assert_eq!(trigger_for("x/y", 200_000, &v).trigger_tokens, 140_000);
    }

    #[test]
    fn project_config_keys_are_found_by_dotted_path() {
        let text =
            "compaction:\n  thresholdPercent: 50\n  other: 1\ntask:\n  maxConcurrency: 2\nfoo: 1\n";
        assert_eq!(
            overrides_in(text),
            vec!["compaction.thresholdPercent", "task.maxConcurrency"]
        );
    }
}
