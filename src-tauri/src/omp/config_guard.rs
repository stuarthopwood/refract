// OMP settings guard (#1184, spec 020). OMP reads its config once at process start, so Refract
// checks a fixed set of token-cost keys at app start and immediately before each `omp` launch
// and resets any that drifted from the baseline below through `omp config set` (global config).
// It never blocks a launch (`run_before_launch` is bounded by `LAUNCH_TIMEOUT`), never edits a
// Project's `.omp/config.yml` (only reads it, to name an override), and tells the renderer once
// per run that changed or failed something (`omp-guard:reset`).
//
// Item 5 of the issue (a "Guarded" tag in Settings, editing the baseline) is #691: until it
// lands the baseline is these built-in defaults.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use super::config::{run_json, set_config};
use crate::events::EventSink;
use crate::ipc::model_roles::set_model_role;

const CACHE_TTL: Duration = Duration::from_secs(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(6);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const PROJECT_CONFIG: &str = ".omp/config.yml";
const ADVISOR_KEY: &str = "modelRoles.advisor";
const ADVISOR_SELECTOR: &str = "github-copilot/gemini-4-argon:auto";
const THRESHOLDS_KEY: &str = "compaction.modelThresholds";
const MODEL_THRESHOLDS: [(&str, u64); 6] = [
    ("github-copilot/claude-opus-5.5", 200_000),
    ("github-copilot/claude-sonnet-5.5", 120_000),
    ("github-copilot/claude-sonnet-5", 120_000),
    ("github-copilot/claude-haiku-5.5", 120_000),
    ("github-copilot/gemini-4-argon", 150_000),
    ("github-copilot/gpt-5.6-terra", 150_000),
];

/// The scalar baseline: `omp config set <key> <value>` takes each key directly.
fn scalar_baseline() -> Vec<(&'static str, Value)> {
    vec![
        ("advisor.reviewMode", Value::from("agent-end")),
        ("compaction.thresholdTokens", Value::from(200_000)),
        ("compaction.idleEnabled", Value::from(true)),
        ("compaction.idleThresholdTokens", Value::from(80_000)),
        ("compaction.idleTimeoutSeconds", Value::from(240)),
        ("task.softRequestBudget", Value::from(80)),
        ("task.maxConcurrency", Value::from(6)),
        ("autolearn.autoContinue", Value::from(false)),
    ]
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResetEntry {
    pub key: String,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FailureEntry {
    pub key: String,
    pub old: String,
    pub new: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OverrideEntry {
    pub key: String,
    pub file: String,
}

/// The `omp-guard:reset` payload: one per guard run that reset or failed anything.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GuardNotice {
    pub id: u64,
    pub resets: Vec<ResetEntry>,
    pub failures: Vec<FailureEntry>,
    pub overrides: Vec<OverrideEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DriftKind {
    Scalar,
    AdvisorRole,
    Threshold(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Drift {
    pub key: String,
    pub kind: DriftKind,
    pub old: Option<Value>,
    pub new: Value,
}

fn canonical_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Representation-independent form: `120000`, `120000.0` and `"120000"` match; `true` and
/// `"true"` match. `None` for null.
pub fn normalise(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => n.as_f64().map(canonical_number),
        Value::String(s) => {
            let trimmed = s.trim();
            match trimmed.parse::<f64>() {
                Ok(n) if n.is_finite() => Some(canonical_number(n)),
                _ if trimmed.eq_ignore_ascii_case("true") => Some("true".into()),
                _ if trimmed.eq_ignore_ascii_case("false") => Some("false".into()),
                _ => Some(trimmed.to_string()),
            }
        }
        other => Some(other.to_string()),
    }
}

pub fn same_value(current: Option<&Value>, baseline: &Value) -> bool {
    match (current.and_then(normalise), normalise(baseline)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn list_value<'a>(list: &'a Value, key: &str) -> Option<Option<&'a Value>> {
    list.get(key).map(|entry| entry.get("value"))
}

/// Compares `omp config list --json` against the baseline. A key the list does not know (older
/// OMP) is skipped; a known key with no value counts as drift.
pub fn plan_drift(list: &Value) -> Vec<Drift> {
    let mut drifts = Vec::new();
    for (key, baseline) in scalar_baseline() {
        if let Some(current) = list_value(list, key) {
            if !same_value(current, &baseline) {
                drifts.push(Drift {
                    key: key.to_string(),
                    kind: DriftKind::Scalar,
                    old: current.cloned(),
                    new: baseline,
                });
            }
        }
    }
    if let Some(roles) = list_value(list, "modelRoles") {
        let current = roles.and_then(|r| r.get("advisor"));
        let baseline = Value::from(ADVISOR_SELECTOR);
        if !same_value(current, &baseline) {
            drifts.push(Drift {
                key: ADVISOR_KEY.to_string(),
                kind: DriftKind::AdvisorRole,
                old: current.cloned(),
                new: baseline,
            });
        }
    }
    if let Some(record) = list_value(list, THRESHOLDS_KEY) {
        for (model, limit) in MODEL_THRESHOLDS {
            let current = record.and_then(|r| r.get(model));
            let baseline = Value::from(limit);
            if !same_value(current, &baseline) {
                drifts.push(Drift {
                    key: format!("{THRESHOLDS_KEY}.{model}"),
                    kind: DriftKind::Threshold(model.to_string()),
                    old: current.cloned(),
                    new: baseline,
                });
            }
        }
    }
    drifts
}

fn display(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "unset".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Every dotted key path a YAML mapping file sets (comments and list items ignored; a flat
/// dotted key counts as its own path). Read-only helper for naming Project overrides.
pub fn scan_yaml_paths(yaml: &str) -> Vec<String> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut paths = Vec::new();
    for raw in yaml.lines() {
        let line = raw.split(" #").next().unwrap_or("").trim_end();
        let content = line.trim_start();
        if content.is_empty() || content.starts_with('#') || content.starts_with('-') {
            continue;
        }
        let indent = line.len() - content.len();
        let colon = match content.find(": ") {
            Some(i) => i,
            None if content.ends_with(':') => content.len() - 1,
            None => continue,
        };
        let key = content[..colon]
            .trim()
            .trim_matches(|c| c == '"' || c == '\'');
        if key.is_empty() {
            continue;
        }
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let mut path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
        path.push(key);
        paths.push(path.join("."));
        stack.push((indent, key.to_string()));
    }
    paths
}

/// The guarded keys a project file overrides.
pub fn overridden_guarded_keys(paths: &[String]) -> Vec<String> {
    let mut guarded: Vec<&str> = scalar_baseline().iter().map(|(k, _)| *k).collect();
    guarded.push(ADVISOR_KEY);
    guarded.push(THRESHOLDS_KEY);
    guarded
        .into_iter()
        .filter(|key| {
            paths
                .iter()
                .any(|p| p == key || p.starts_with(&format!("{key}.")))
        })
        .map(str::to_string)
        .collect()
}

struct GuardState {
    cache: Option<(Instant, Value)>,
}

static STATE: AsyncMutex<GuardState> = AsyncMutex::const_new(GuardState { cache: None });
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static PENDING: StdMutex<Option<GuardNotice>> = StdMutex::new(None);

async fn apply(list: &Value, drifts: Vec<Drift>) -> (Vec<ResetEntry>, Vec<FailureEntry>) {
    let mut resets = Vec::new();
    let mut failures = Vec::new();
    let mut thresholds: Vec<Drift> = Vec::new();
    for drift in drifts {
        let result = match &drift.kind {
            DriftKind::Scalar => set_config(&drift.key, &drift.new, &[])
                .await
                .map(|_| ())
                .map_err(|e| e.message),
            DriftKind::AdvisorRole => set_model_role("advisor", drift.new.as_str())
                .await
                .map(|_| ())
                .map_err(|e| e.message),
            DriftKind::Threshold(_) => {
                thresholds.push(drift);
                continue;
            }
        };
        record(&drift, result, &mut resets, &mut failures);
    }
    if !thresholds.is_empty() {
        let mut merged: Map<String, Value> = list_value(list, THRESHOLDS_KEY)
            .flatten()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for drift in &thresholds {
            if let DriftKind::Threshold(model) = &drift.kind {
                merged.insert(model.clone(), drift.new.clone());
            }
        }
        let result = set_config(THRESHOLDS_KEY, &Value::Object(merged), &[])
            .await
            .map(|_| ())
            .map_err(|e| e.message);
        for drift in &thresholds {
            record(drift, result.clone(), &mut resets, &mut failures);
        }
    }
    (resets, failures)
}

fn record(
    drift: &Drift,
    result: Result<(), String>,
    resets: &mut Vec<ResetEntry>,
    failures: &mut Vec<FailureEntry>,
) {
    let old = display(drift.old.as_ref());
    let new = display(Some(&drift.new));
    match result {
        Ok(()) => {
            log::info!(
                "omp settings guard: reset {} (was {old}) -> {new}",
                drift.key
            );
            resets.push(ResetEntry {
                key: drift.key.clone(),
                old,
                new,
            });
        }
        Err(error) => {
            log::warn!("omp settings guard: could not reset {}: {error}", drift.key);
            failures.push(FailureEntry {
                key: drift.key.clone(),
                old,
                new,
                error,
            });
        }
    }
}

async fn project_overrides(project_dir: &Path) -> Vec<OverrideEntry> {
    let file = project_dir.join(PROJECT_CONFIG);
    match tokio::fs::read_to_string(&file).await {
        Ok(yaml) => overridden_guarded_keys(&scan_yaml_paths(&yaml))
            .into_iter()
            .map(|key| OverrideEntry {
                key,
                file: PROJECT_CONFIG.to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// One guard run: serialised, cached read, reset, notice (only when something changed or failed).
pub async fn run(project_dir: Option<&Path>) -> Option<GuardNotice> {
    let mut state = STATE.lock().await;
    let list = match &state.cache {
        Some((at, list)) if at.elapsed() < CACHE_TTL => list.clone(),
        _ => match run_json(&["config", "list", "--json"], "Could not read omp config.").await {
            Ok(list) => {
                state.cache = Some((Instant::now(), list.clone()));
                list
            }
            Err(err) => {
                log::warn!("omp settings guard: config list failed: {}", err.message);
                return None;
            }
        },
    };
    let drifts = plan_drift(&list);
    if drifts.is_empty() {
        return None;
    }
    let (resets, failures) = apply(&list, drifts).await;
    state.cache = None;
    drop(state);
    if resets.is_empty() && failures.is_empty() {
        return None;
    }
    let overrides = match project_dir {
        Some(dir) => project_overrides(dir).await,
        None => Vec::new(),
    };
    Some(GuardNotice {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        resets,
        failures,
        overrides,
    })
}

fn take_pending() -> Option<GuardNotice> {
    PENDING.lock().ok().and_then(|mut p| p.take())
}

/// App start: the renderer may not be listening yet, so the notice is also kept for the next
/// launch-time run to re-deliver once (the renderer ignores an id it already showed).
pub async fn run_at_startup(events: &EventSink) {
    if let Ok(Some(notice)) = tokio::time::timeout(STARTUP_TIMEOUT, run(None)).await {
        if let Ok(mut pending) = PENDING.lock() {
            *pending = Some(notice.clone());
        }
        events.emit_omp_guard_reset(&notice);
    }
}

/// Immediately before an `omp` launch. Never fails and never waits past `LAUNCH_TIMEOUT`.
pub async fn run_before_launch(events: &EventSink, project_dir: &Path) {
    match tokio::time::timeout(LAUNCH_TIMEOUT, run(Some(project_dir))).await {
        Ok(Some(notice)) => {
            take_pending();
            events.emit_omp_guard_reset(&notice);
        }
        Ok(None) => {
            if let Some(notice) = take_pending() {
                events.emit_omp_guard_reset(&notice);
            }
        }
        Err(_) => log::warn!("omp settings guard: timed out, launching anyway"),
    }
}

#[cfg(test)]
#[path = "config_guard_tests.rs"]
mod tests;
