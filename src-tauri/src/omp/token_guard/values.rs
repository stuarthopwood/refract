// Token guard values store (`token-guard.json`). A bad stored value falls back to its default for that key only.

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
    ("read.summarize.enabled", Kind::Bool),
    ("todo.eager", Kind::Text),
    ("prewalk.enabled", Kind::Bool),
    ("plan.defaultOnStartup", Kind::Bool),
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
    /// Set once the old 200-line `read.defaultLimit` default has been migrated to 1000 (#1545).
    #[serde(default)]
    read_limit_migrated: bool,
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
        "read.defaultLimit" => json!(1000),
        "read.summarize.enabled" => json!(false),
        "todo.eager" => json!("default"),
        "prewalk.enabled" => json!(false),
        "plan.defaultOnStartup" => json!(false),
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

const MAX_TEXT_CHARS: usize = 200;
const MAX_ENTRIES: usize = 64;
const METHODS: &[&str] = &["remote", "snapcompact", "shake", "handoff", "soft"];
const REVIEW_MODES: &[&str] = &["agent-end", "turn"];
const TODO_EAGER_MODES: &[&str] = &["default", "preferred", "always"];

/// Upper bound for a count key (thresholds and line/size counts share the token ceiling).
fn max_count(key: &str) -> u64 {
    match key {
        "task.maxConcurrency" => 64,
        "task.softRequestBudget" => 10_000,
        _ => 2_000_000,
    }
}

fn is_count(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|n| n <= max)
}

fn is_text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= MAX_TEXT_CHARS)
}

fn is_member(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|s| allowed.contains(&s))
}

/// Per-type validation (data-model.md): counts are bounded non-negative integers, text is
/// non-empty and short, lists and maps are size-capped, enum-like keys take known values only.
pub fn validate(key: &str, value: &Value) -> Result<(), String> {
    let kind = kind_of(key).ok_or_else(|| format!("Unknown token guard key: {key}"))?;
    let max = max_count(key);
    let ok = match (kind, key) {
        (Kind::Int, _) => is_count(value, max),
        (Kind::Bool, _) => value.is_boolean(),
        (Kind::Text, "advisor.reviewMode") => is_member(value, REVIEW_MODES),
        (Kind::Text, "todo.eager") => is_member(value, TODO_EAGER_MODES),
        (Kind::Text, _) => is_text(value),
        (Kind::TextList, _) => value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= MAX_ENTRIES
                && items.iter().all(|i| is_member(i, METHODS))
        }),
        (Kind::IntRecord, _) => value.as_object().is_some_and(|map| {
            map.len() <= MAX_ENTRIES
                && map.iter().all(|(k, v)| {
                    !k.trim().is_empty() && k.chars().count() <= MAX_TEXT_CHARS && is_count(v, max)
                })
        }),
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
    let mut stored: Stored = read_json_file(&store_path(dir), Stored::default)
        .await
        .unwrap_or_default();
    // Persisted with the next write; until then this runs again with the same outcome.
    if !stored.read_limit_migrated {
        if stored.overrides.get("read.defaultLimit") == Some(&json!(200)) {
            stored.overrides.remove("read.defaultLimit");
        }
        stored.read_limit_migrated = true;
    }
    stored
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

    #[test]
    fn rejects_out_of_bounds_values() {
        assert!(validate("task.maxConcurrency", &json!(65)).is_err());
        assert!(validate("task.softRequestBudget", &json!(10_001)).is_err());
        assert!(validate("compaction.thresholdTokens", &json!(2_000_001)).is_err());
        assert!(validate("compaction.methodOrder", &json!(["shake", "rm"])).is_err());
        assert!(validate("advisor.reviewMode", &json!("whatever")).is_err());
        assert!(validate("advisor.reviewMode", &json!("turn")).is_ok());
        assert!(validate("modelRoles.advisor", &json!("x".repeat(201))).is_err());
    }
}
