// Token guard values store (`token-guard.json`). A bad stored value falls back to its default for that key only.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::ipc::model_roles::set_model_role_with;
use crate::omp::config::{
    list_config_with, set_config_with, OmpConfigError, OmpExecutor, RealOmpExecutor,
};

pub const STORE_VERSION: u32 = 2;

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
    ("providers.cacheWarming", Kind::Text),
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

fn kind_of(key: &str) -> Option<Kind> {
    KEYS.iter().find(|(k, _)| *k == key).map(|(_, kind)| *kind)
}

pub fn is_key(key: &str) -> bool {
    kind_of(key).is_some()
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
        "task.softRequestBudget" => json!(60),
        "providers.cacheWarming" => json!("idle"),
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
const CACHE_WARMING_MODES: &[&str] = &["off", "streaming", "idle"];
/// The agent clamps a percent threshold to this range.
const PERCENT_RANGE: std::ops::RangeInclusive<u64> = 1..=99;
const MODEL_THRESHOLD_MAX_TOKENS: u64 = 100_000_000;

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

/// `"f<tokens>"`: a fixed trigger in tokens.
fn is_fixed_string(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| s.strip_prefix('f'))
        .is_some_and(|digits| {
            (1..=9).contains(&digits.len())
                && !digits.starts_with('0')
                && digits.bytes().all(|b| b.is_ascii_digit())
        })
}

/// A `compaction.modelThresholds` entry: a token base (`120000`), a fixed trigger (`"f200000"`) or a percent (`"80%"`).
fn is_model_threshold(value: &Value) -> bool {
    is_count(value, 1, MODEL_THRESHOLD_MAX_TOKENS)
        || is_fixed_string(value)
        || is_percent_string(value)
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
        (Kind::Text, "providers.cacheWarming") => is_member(value, CACHE_WARMING_MODES),
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
                        && is_model_threshold(v)
                })
        }),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid value for {key}"))
    }
}

/// The value `omp config list --json` holds for a key, as stored (no validation or default).
pub fn raw_value<'a>(list: &'a Value, key: &str) -> Option<&'a Value> {
    match key.strip_prefix("modelRoles.") {
        Some(role) => list.pointer(&format!("/modelRoles/value/{role}")),
        None => list.get(key).and_then(|entry| entry.get("value")),
    }
}

/// The effective value of every token guard key in one `omp config list --json` result. A value
/// that fails validation (for example omp's own `-1` percent) is shown as Refract's default.
pub fn effective_from_list(list: &Value) -> ValueMap {
    let mut values = defaults();
    for (key, _) in KEYS {
        if let Some(value) = raw_value(list, key).filter(|v| validate(key, v).is_ok()) {
            values.insert((*key).to_string(), value.clone());
        }
    }
    values
}

/// What one `omp config list` yields for the token guard: its values plus the default model
/// (not a token guard key, but it picks the compaction trigger shown next to them).
#[derive(Clone)]
pub struct Global {
    pub values: ValueMap,
    pub default_model: Option<String>,
}

impl Global {
    fn from_list(list: &Value) -> Self {
        Self {
            values: effective_from_list(list),
            default_model: raw_value(list, "modelRoles.default")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

/// The last snapshot read from omp. A write patches it instead of paying for another
/// `omp config list` (about 2 s); `load_global` refreshes it, so an outside edit shows up the next
/// time Settings loads.
static SNAPSHOT: std::sync::Mutex<Option<Global>> = std::sync::Mutex::new(None);

fn cached() -> Option<Global> {
    SNAPSHOT.lock().expect("poisoned").clone()
}

fn remember(global: &Global) {
    *SNAPSHOT.lock().expect("poisoned") = Some(global.clone());
}

pub(crate) fn forget() {
    *SNAPSHOT.lock().expect("poisoned") = None;
}

fn omp_error(err: OmpConfigError) -> String {
    format!("Could not save token guard values: {}", err.message)
}

/// Reads every key from the global omp config with one `omp config list`.
pub async fn load_global_with(executor: &dyn OmpExecutor) -> Result<Global, String> {
    let list = list_config_with(executor, &[])
        .await
        .map_err(|err| format!("Could not read token guard values: {}", err.message))?;
    let global = Global::from_list(&list);
    remember(&global);
    Ok(global)
}

pub async fn load_global() -> Result<Global, String> {
    load_global_with(&RealOmpExecutor).await
}

/// The remembered snapshot, or a fresh read when there is none yet.
async fn current(executor: &dyn OmpExecutor) -> Result<Global, String> {
    match cached() {
        Some(global) => Ok(global),
        None => load_global_with(executor).await,
    }
}

/// Writes one key to the global omp config. The advisor role is read-merge-written because `omp config get modelRoles.advisor` is unsupported.
pub async fn write_key(executor: &dyn OmpExecutor, key: &str, value: &Value) -> Result<(), String> {
    validate(key, value)?;
    if key == "modelRoles.advisor" {
        let selector = value.as_str().unwrap_or_default();
        return set_model_role_with(executor, "advisor", Some(selector))
            .await
            .map(|_| ())
            .map_err(omp_error);
    }
    set_config_with(executor, key, value, &[])
        .await
        .map_err(omp_error)?;
    // `prewalk.auto` adds a model call per task independent of `prewalk.enabled` (#695).
    if key == "prewalk.enabled" && value == &Value::Bool(false) {
        set_config_with(executor, "prewalk.auto", &json!("off"), &[])
            .await
            .map_err(omp_error)?;
    }
    Ok(())
}

/// Stores a deliberate change for one key and returns the new effective values.
pub async fn set(executor: &dyn OmpExecutor, key: &str, value: Value) -> Result<Global, String> {
    if let Err(err) = write_key(executor, key, &value).await {
        // A write that fails midway (the prewalk pair) may have changed omp anyway.
        forget();
        return Err(err);
    }
    let mut global = current(executor).await?;
    global.values.insert(key.to_string(), value);
    remember(&global);
    Ok(global)
}

/// Writes Refract's default for one key (omp has no unset) and returns the new effective values.
pub async fn reset(executor: &dyn OmpExecutor, key: &str) -> Result<Global, String> {
    let default = default_for(key).ok_or_else(|| format!("Unknown token guard key: {key}"))?;
    set(executor, key, default).await
}

/// Writes Refract's default for every key (the "Optimise token usage" button).
pub async fn reset_all(executor: &dyn OmpExecutor) -> Result<Global, String> {
    for (key, value) in defaults() {
        if let Err(err) = write_key(executor, &key, &value).await {
            // Some keys are already written, so the remembered snapshot no longer matches.
            forget();
            return Err(err);
        }
    }
    let mut global = current(executor).await?;
    global.values = defaults();
    remember(&global);
    Ok(global)
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
    fn list_result_falls_back_per_key_and_reads_the_advisor() {
        let list = json!({
            "task.maxConcurrency": { "value": "many" },
            "task.softRequestBudget": { "value": 40 },
            "compaction.thresholdPercent": { "value": -1 },
            "modelRoles": { "value": { "advisor": "p/m:auto" } }
        });
        let values = effective_from_list(&list);
        assert_eq!(values["task.maxConcurrency"], json!(6));
        assert_eq!(values["task.softRequestBudget"], json!(40));
        assert_eq!(values["compaction.thresholdPercent"], json!(70));
        assert_eq!(values["modelRoles.advisor"], json!("p/m:auto"));
    }

    #[test]
    fn one_list_gives_the_values_and_the_default_model() {
        let list = json!({
            "task.maxConcurrency": { "value": 3 },
            "modelRoles": { "value": { "default": "p/m:high", "advisor": "p/a:auto" } }
        });
        let global = Global::from_list(&list);
        assert_eq!(global.default_model.as_deref(), Some("p/m:high"));
        assert_eq!(global.values["task.maxConcurrency"], json!(3));
        assert_eq!(global.values["modelRoles.advisor"], json!("p/a:auto"));
        assert_eq!(raw_value(&list, "compaction.thresholdPercent"), None);
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
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": 70 })).is_ok());
        // Unknown key: rejected as unknown, not by a range check.
        assert!(validate("compaction.thresholdTokens", &json!(200_000)).is_err());
        assert!(validate("compaction.modelThresholds", &json!({ "a/b": "05%" })).is_err());
        assert!(validate("compaction.methodOrder", &json!(["shake", "rm"])).is_err());
        assert!(validate("advisor.reviewMode", &json!("whatever")).is_err());
        assert!(validate("advisor.reviewMode", &json!("turn")).is_ok());
        assert!(validate("modelRoles.advisor", &json!("x".repeat(201))).is_err());
    }

    #[test]
    fn model_thresholds_accept_tokens_fixed_and_percent() {
        for ok in [json!(120_000), json!("f200000"), json!("80%")] {
            assert!(
                validate("compaction.modelThresholds", &json!({ "a/b": ok })).is_ok(),
                "{ok}"
            );
        }
        for bad in [
            json!(0),
            json!(-5),
            json!("f"),
            json!("f0"),
            json!("200000"),
            json!("x%"),
        ] {
            assert!(
                validate("compaction.modelThresholds", &json!({ "a/b": bad })).is_err(),
                "{bad}"
            );
        }
    }
    #[test]
    fn cache_warming_accepts_known_modes_only() {
        for ok in ["idle", "off", "streaming"] {
            assert!(
                validate("providers.cacheWarming", &json!(ok)).is_ok(),
                "{ok}"
            );
        }
        assert!(validate("providers.cacheWarming", &json!("always")).is_err());
        assert!(validate("providers.cacheWarming", &json!("")).is_err());
    }
}
