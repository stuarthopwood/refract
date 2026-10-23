// The token guard values store (`token-guard.json` in the Refract data dir). Only deliberate
// developer changes are persisted (`overrides`); the effective value of every key is its
// override when that validates, otherwise the grilled default (FR-006), so one bad stored value
// falls back for that key alone. Keys are the dotted OMP config keys of the overlay.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::store::atomic_json::{read_json_file, write_json_file};

pub const STORE_VERSION: u32 = 1;
const FILE_NAME: &str = "token-guard.json";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Int,
    Bool,
    Text,
    TextList,
    IntRecord,
}

const KEYS: &[(&str, Kind)] = &[
    ("compaction.modelThresholds", Kind::IntRecord),
    ("compaction.thresholdTokens", Kind::Int),
    ("compaction.idleEnabled", Kind::Bool),
    ("compaction.idleThresholdTokens", Kind::Int),
    ("compaction.idleTimeoutSeconds", Kind::Int),
    ("compaction.methodOrder", Kind::TextList),
    ("snapcompact.toolResults", Kind::Bool),
    ("snapcompact.systemPrompt", Kind::Text),
    ("task.softRequestBudget", Kind::Int),
    ("task.maxConcurrency", Kind::Int),
    ("autolearn.autoContinue", Kind::Bool),
    ("advisor.reviewMode", Kind::Text),
    ("modelRoles.advisor", Kind::Text),
    ("grep.contextBefore", Kind::Int),
    ("grep.contextAfter", Kind::Int),
    ("read.defaultLimit", Kind::Int),
    ("tools.artifactSpillThreshold", Kind::Int),
    ("tools.xdev", Kind::Bool),
];

pub type ValueMap = BTreeMap<String, Value>;

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    overrides: BTreeMap<String, Value>,
}

/// Serialises read-modify-write on the store file (Settings edits and launch reads).
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn kind_of(key: &str) -> Option<Kind> {
    KEYS.iter().find(|(k, _)| *k == key).map(|(_, kind)| *kind)
}

pub fn default_for(key: &str) -> Option<Value> {
    Some(match key {
        "compaction.modelThresholds" => json!({
            "github-copilot/claude-opus-5.5": 200000,
            "github-copilot/claude-sonnet-5.5": 120000,
            "github-copilot/claude-sonnet-5": 120000,
            "github-copilot/claude-haiku-5.5": 120000,
            "github-copilot/gemini-4-argon": 150000,
            "github-copilot/gpt-5.6-terra": 150000,
        }),
        "compaction.thresholdTokens" => json!(200000),
        "compaction.idleEnabled" => json!(true),
        "compaction.idleThresholdTokens" => json!(80000),
        "compaction.idleTimeoutSeconds" => json!(240),
        "compaction.methodOrder" => json!(["snapcompact", "shake", "handoff", "soft"]),
        "snapcompact.toolResults" => json!(true),
        "snapcompact.systemPrompt" => json!("none"),
        "task.softRequestBudget" => json!(80),
        "task.maxConcurrency" => json!(6),
        "autolearn.autoContinue" => json!(false),
        "advisor.reviewMode" => json!("agent-end"),
        "modelRoles.advisor" => json!("github-copilot/gemini-4-argon:auto"),
        "grep.contextBefore" => json!(0),
        "grep.contextAfter" => json!(1),
        "read.defaultLimit" => json!(200),
        "tools.artifactSpillThreshold" => json!(30),
        "tools.xdev" => json!(true),
        _ => return None,
    })
}

pub fn defaults() -> ValueMap {
    KEYS.iter()
        .filter_map(|(key, _)| default_for(key).map(|v| ((*key).to_string(), v)))
        .collect()
}

fn is_count(value: &Value) -> bool {
    value.as_u64().is_some()
}

fn is_text(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}

/// Per-type validation (data-model.md): counts are non-negative integers, text is non-empty.
pub fn validate(key: &str, value: &Value) -> Result<(), String> {
    let kind = kind_of(key).ok_or_else(|| format!("Unknown token guard key: {key}"))?;
    let ok = match kind {
        Kind::Int => is_count(value),
        Kind::Bool => value.is_boolean(),
        Kind::Text => is_text(value),
        Kind::TextList => value
            .as_array()
            .is_some_and(|items| !items.is_empty() && items.iter().all(is_text)),
        Kind::IntRecord => value
            .as_object()
            .is_some_and(|map| map.iter().all(|(k, v)| !k.trim().is_empty() && is_count(v))),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid value for {key}"))
    }
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

async fn read_stored(dir: &Path) -> Stored {
    read_json_file(&store_path(dir), Stored::default)
        .await
        .unwrap_or_default()
}

fn effective(stored: &Stored) -> ValueMap {
    let mut values = defaults();
    for (key, value) in &stored.overrides {
        if validate(key, value).is_ok() {
            values.insert(key.clone(), value.clone());
        }
    }
    values
}

/// The effective values for every overlay key (defaults overlaid by valid overrides).
pub async fn load(dir: &Path) -> ValueMap {
    let _guard = STORE_LOCK.lock().await;
    effective(&read_stored(dir).await)
}

/// Stores a deliberate change for one key and returns the new effective values.
pub async fn set(dir: &Path, key: &str, value: Value) -> Result<ValueMap, String> {
    validate(key, &value)?;
    let _guard = STORE_LOCK.lock().await;
    let mut stored = read_stored(dir).await;
    stored.version = STORE_VERSION;
    stored.overrides.insert(key.to_string(), value);
    write_json_file(&store_path(dir), &stored)
        .await
        .map_err(|err| format!("Could not save token guard values: {err}"))?;
    Ok(effective(&stored))
}

/// Drops the override for one key (back to the default) and returns the new effective values.
pub async fn reset(dir: &Path, key: &str) -> Result<ValueMap, String> {
    if kind_of(key).is_none() {
        return Err(format!("Unknown token guard key: {key}"));
    }
    let _guard = STORE_LOCK.lock().await;
    let mut stored = read_stored(dir).await;
    stored.version = STORE_VERSION;
    stored.overrides.remove(key);
    write_json_file(&store_path(dir), &stored)
        .await
        .map_err(|err| format!("Could not save token guard values: {err}"))?;
    Ok(effective(&stored))
}

pub fn to_object(values: &ValueMap) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<Map<_, _>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_has_a_valid_default() {
        for (key, _) in KEYS {
            let value = default_for(key).expect("default");
            assert!(validate(key, &value).is_ok(), "{key}");
        }
    }

    #[test]
    fn invalid_override_falls_back_per_key() {
        let mut stored = Stored::default();
        stored
            .overrides
            .insert("task.maxConcurrency".into(), json!("many"));
        stored
            .overrides
            .insert("task.softRequestBudget".into(), json!(40));
        let values = effective(&stored);
        assert_eq!(values["task.maxConcurrency"], json!(6));
        assert_eq!(values["task.softRequestBudget"], json!(40));
    }

    #[test]
    fn rejects_unknown_and_negative() {
        assert!(validate("nope", &json!(1)).is_err());
        assert!(validate("task.maxConcurrency", &json!(-1)).is_err());
    }
}
