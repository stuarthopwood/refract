// Token guard values store (`token-guard.json`). A bad stored value falls back to its default for that key only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::store::atomic_json::{read_json_file, write_json_file};

pub const STORE_VERSION: u32 = 2;
/// Version at which thresholds became percents; older stores drop their token thresholds.
const PERCENT_STORE_VERSION: u32 = 2;
const FILE_NAME: &str = "token-guard.json";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Int,
    Bool,
    Text,
    TextList,
    PercentRecord,
}

const KEYS: &[(&str, Kind)] = &[
    ("compaction.modelThresholds", Kind::PercentRecord),
    ("compaction.thresholdPercent", Kind::Int),
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
    /// Set when the version 2 migration dropped stored token thresholds; cleared once Settings has told the user.
    #[serde(default)]
    thresholds_reset_pending: bool,
}

/// Serialises read-modify-write on the store file (Settings edits and launch reads).
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn kind_of(key: &str) -> Option<Kind> {
    KEYS.iter().find(|(k, _)| *k == key).map(|(_, kind)| *kind)
}

pub fn default_for(key: &str) -> Option<Value> {
    Some(match key {
        "compaction.modelThresholds" => json!({}),
        "compaction.thresholdPercent" => json!(70),
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
/// The agent clamps a percent threshold to this range.
const PERCENT_RANGE: std::ops::RangeInclusive<u64> = 1..=99;
/// Token thresholds the version 1 store held; the percent keys replace them.
const LEGACY_THRESHOLD_KEYS: &[&str] =
    &["compaction.thresholdTokens", "compaction.modelThresholds"];

/// Upper bound for a count key (thresholds and line/size counts share the token ceiling).
fn max_count(key: &str) -> u64 {
    match key {
        "compaction.thresholdPercent" => *PERCENT_RANGE.end(),
        "task.maxConcurrency" => 64,
        "task.softRequestBudget" => 10_000,
        _ => 2_000_000,
    }
}

fn min_count(key: &str) -> u64 {
    match key {
        "compaction.thresholdPercent" => *PERCENT_RANGE.start(),
        _ => 0,
    }
}

fn is_count(value: &Value, min: u64, max: u64) -> bool {
    value.as_u64().is_some_and(|n| (min..=max).contains(&n))
}

/// `"N%"` with N a whole percent 1-99 (`^(\d{1,2})%$`).
fn is_percent_string(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| s.strip_suffix('%'))
        .is_some_and(|digits| {
            (1..=2).contains(&digits.len())
                && !digits.starts_with('0')
                && digits.bytes().all(|b| b.is_ascii_digit())
                && digits
                    .parse::<u64>()
                    .is_ok_and(|n| PERCENT_RANGE.contains(&n))
        })
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
    let (min, max) = (min_count(key), max_count(key));
    let ok = match (kind, key) {
        (Kind::Int, _) => is_count(value, min, max),
        (Kind::Bool, _) => value.is_boolean(),
        (Kind::Text, "advisor.reviewMode") => is_member(value, REVIEW_MODES),
        (Kind::Text, "todo.eager") => is_member(value, TODO_EAGER_MODES),
        (Kind::Text, _) => is_text(value),
        (Kind::TextList, _) => value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= MAX_ENTRIES
                && items.iter().all(|i| is_member(i, METHODS))
        }),
        (Kind::PercentRecord, _) => value.as_object().is_some_and(|map| {
            map.len() <= MAX_ENTRIES
                && map.iter().all(|(k, v)| {
                    !k.trim().is_empty()
                        && k.chars().count() <= MAX_TEXT_CHARS
                        && is_percent_string(v)
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
    if stored.version < PERCENT_STORE_VERSION {
        let dropped = LEGACY_THRESHOLD_KEYS
            .iter()
            .filter(|key| stored.overrides.remove(**key).is_some())
            .count();
        stored.thresholds_reset_pending |= dropped > 0;
        stored.version = PERCENT_STORE_VERSION;
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

/// True while the store has dropped token thresholds and Settings has not yet told the user.
pub async fn thresholds_reset_pending(dir: &Path) -> bool {
    let _guard = STORE_LOCK.lock().await;
    read_stored(dir).await.thresholds_reset_pending
}

/// Clears the pending notice once Settings has shown it.
pub async fn dismiss_thresholds_reset(dir: &Path) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().await;
    let mut stored = read_stored(dir).await;
    if !stored.thresholds_reset_pending {
        return Ok(());
    }
    stored.thresholds_reset_pending = false;
    write_json_file(&store_path(dir), &stored)
        .await
        .map_err(|err| format!("Could not save token guard values: {err}"))
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
        assert!(validate("compaction.thresholdPercent", &json!(0)).is_err());
        assert!(validate("compaction.thresholdPercent", &json!(100)).is_err());
        assert!(validate("compaction.thresholdPercent", &json!(99)).is_ok());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": "70%" })).is_ok());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": "100%" })).is_err());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": "0%" })).is_err());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": 70 })).is_err());
        // Unknown key: rejected as unknown, not by a range check.
        assert!(validate("compaction.thresholdTokens", &json!(200_000)).is_err());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": "05%" })).is_err());
        assert!(validate("compaction.methodOrder", &json!(["shake", "rm"])).is_err());
        assert!(validate("advisor.reviewMode", &json!("whatever")).is_err());
        assert!(validate("advisor.reviewMode", &json!("turn")).is_ok());
        assert!(validate("modelRoles.advisor", &json!("x".repeat(201))).is_err());
    }
}
