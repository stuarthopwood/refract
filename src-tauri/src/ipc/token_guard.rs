// `tokenGuard.get/set/reset/resetAll/dismissThresholdsReset`. No path or file content comes from the renderer.
// A change reaches running Sessions for `live` keys; the rest apply to the next launched Session.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::ipc::model_roles::list_catalog_models;
use crate::omp::advisor_roster::agent_dir;
use crate::omp::config::{OmpExecutor, RealOmpExecutor};
use crate::omp::token_guard::values::{self, Global};
use crate::omp::token_guard::{legacy, migrate, overlay, triggers};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("tokenGuard.get", token_guard_get);
    d.register("tokenGuard.set", token_guard_set);
    d.register("tokenGuard.reset", token_guard_reset);
    d.register("tokenGuard.resetAll", token_guard_reset_all);
    d.register(
        "tokenGuard.dismissThresholdsReset",
        token_guard_dismiss_thresholds_reset,
    );
    d.register("tokenGuard.handoff", token_guard_handoff);
}

/// `tokenGuard.handoff`: a refused or failed hand-off is a result, not an IPC error.
fn token_guard_handoff(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument(
                "tokenGuard.handoff expects a string sessionId",
            ));
        };
        if state
            .registry
            .lock()
            .await
            .get_session(&session_id)
            .is_none()
        {
            return Err(super::not_found(format!("Session not found: {session_id}")));
        }
        let agent = state.session_manager.get_or_create_agent(&session_id);
        Ok(match agent.hand_off().await {
            Ok(()) => json!({ "ok": true }),
            Err(err) => json!({ "ok": false, "reason": err.message }),
        })
    })
}

type ContextWindows = Arc<HashMap<String, i64>>;

/// Model context windows by selector. `omp models` takes about a second, so a write reuses what
/// the last Settings load read; only `tokenGuard.get` refreshes it.
static CONTEXT_WINDOWS: Mutex<Option<ContextWindows>> = Mutex::new(None);

async fn context_windows(refresh: bool) -> ContextWindows {
    let cached = CONTEXT_WINDOWS.lock().expect("poisoned").clone();
    if let (false, Some(windows)) = (refresh, &cached) {
        return Arc::clone(windows);
    }
    match list_catalog_models("chat").await {
        Ok(entries) => {
            let windows: ContextWindows = Arc::new(
                entries
                    .into_iter()
                    .filter_map(|e| Some((e.selector, e.context_window?)))
                    .collect(),
            );
            *CONTEXT_WINDOWS.lock().expect("poisoned") = Some(Arc::clone(&windows));
            windows
        }
        Err(_) => cached.unwrap_or_default(),
    }
}

fn snapshot(values: &values::ValueMap) -> Value {
    json!({ "values": values::to_object(values), "defaults": values::to_object(&values::defaults()) })
}

/// Default model plus the models of open Sessions, each with its resulting compaction trigger.
async fn effective_triggers(
    state: &AppState,
    global: &Global,
    windows: &HashMap<String, i64>,
) -> Vec<Value> {
    let mut models: Vec<String> = global.default_model.iter().cloned().collect();
    for s in state.registry.lock().await.snapshot().sessions {
        if s.archived_at.is_none() {
            if let Some(m) = s.last_model {
                let id = format!("{}/{}", m.provider, m.id);
                if !models.contains(&id) {
                    models.push(id);
                }
            }
        }
    }
    models
        .iter()
        .filter_map(|model| {
            let bare = model.split(':').next().unwrap_or(model);
            let window = *windows.get(model.as_str()).or_else(|| windows.get(bare))?;
            serde_json::to_value(triggers::trigger_for(bare, window, &global.values)).ok()
        })
        .collect()
}

async fn project_overrides(state: &AppState, args: &[Value]) -> Vec<String> {
    let Some(id) = args
        .first()
        .and_then(|a| a.get("repositoryId"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    let path = state
        .registry
        .lock()
        .await
        .get_repository(id)
        .map(|r| r.path.clone());
    match path {
        Some(p) => triggers::project_overrides(std::path::Path::new(&p)).await,
        None => Vec::new(),
    }
}

async fn full_snapshot(
    state: &AppState,
    args: &[Value],
    global: &Global,
    windows: &HashMap<String, i64>,
    warnings: &[String],
) -> Value {
    let mut result = snapshot(&global.values);
    result["migration"] = json!(migrate::status(&state.data_dir).await);
    result["effectiveTriggers"] = json!(effective_triggers(state, global, windows).await);
    result["projectOverrides"] = json!(project_overrides(state, args).await);
    result["warnings"] = json!(warnings);
    result
}

fn key_arg(args: &[Value], channel: &str) -> Result<String, IpcError> {
    args.first()
        .and_then(|arg| arg.get("key"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_argument(format!("{channel} expects {{ key }}")))
}

/// The three Settings writes differ only in which `values` call they make.
enum Change {
    Set(String, Value),
    Reset(String),
    ResetAll,
}

struct Applied {
    updated: Global,
    /// Best-effort steps that failed after the write itself succeeded.
    warnings: Vec<String>,
}

/// Migrate check, then the global config write, then the legacy overlay refresh. A write while the
/// migration is pending would be overwritten when it later runs, so a pending one is retried here
/// and the write is refused if it still fails.
async fn apply_change(
    executor: &dyn OmpExecutor,
    dir: &Path,
    config: Option<&Path>,
    legacy_launched: bool,
    change: Change,
) -> Result<Applied, String> {
    if !migrate::ensure_with(executor, dir, config).await {
        let status = migrate::status(dir).await;
        return Err(status
            .error
            .unwrap_or_else(|| "The token guard migration has not finished".to_string()));
    }
    let updated = match change {
        Change::Set(key, value) => values::set(executor, &key, value).await,
        Change::Reset(key) => values::reset(executor, &key).await,
        Change::ResetAll => values::reset_all(executor).await,
    }?;
    // The migration is done here, and omp dies with Refract, so only a Session launched in this
    // process before it finished can still read the legacy overlay (which beats the global config).
    let warnings = if legacy_launched {
        refresh_warning(overlay::refresh_legacy(dir, &updated.values).await)
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };
    Ok(Applied { updated, warnings })
}

/// The legacy refresh is best-effort: the write itself already succeeded, so a failure is shown, not raised.
fn refresh_warning(result: std::io::Result<()>) -> Option<String> {
    let err = result.err()?;
    log::warn!("token guard: could not refresh the legacy overlay ({err})");
    Some(format!(
        "Saved, but a Session started before the migration may keep the old values: {err}"
    ))
}

async fn write_change(
    state: AppState,
    args: Vec<Value>,
    change: Change,
) -> Result<Value, IpcError> {
    let config = agent_dir().map(|d| d.join("config.yml"));
    let applied = apply_change(
        &RealOmpExecutor,
        &state.data_dir,
        config.as_deref(),
        overlay::legacy_session_launched(),
        change,
    )
    .await
    .map_err(invalid_argument)?;
    let windows = context_windows(false).await;
    Ok(full_snapshot(&state, &args, &applied.updated, &windows, &applied.warnings).await)
}

/// Only reports the migration notice: screens other than Settings > Advanced also load, and must
/// not spend it. A migration still running is not awaited: the old values and `pending` come back
/// at once, and the migration runs in the background.
fn token_guard_get(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (global, windows) = if migrate::is_done(&state.data_dir).await {
            let (global, windows) = tokio::join!(values::load_global(), context_windows(true));
            (global.map_err(invalid_argument)?, windows)
        } else {
            migrate::start(&state.data_dir);
            let global = Global {
                values: legacy::effective(&state.data_dir).await,
                default_model: None,
            };
            // Cached windows only: `omp models` would queue on the lock the migration is holding.
            (global, context_windows(false).await)
        };
        Ok(full_snapshot(&state, &args, &global, &windows, &[]).await)
    })
}

fn token_guard_dismiss_thresholds_reset(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        migrate::dismiss_notice(&state.data_dir)
            .await
            .map_err(invalid_argument)?;
        Ok(Value::Null)
    })
}

fn token_guard_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let key = key_arg(&args, "tokenGuard.set")?;
        let value = args
            .first()
            .and_then(|arg| arg.get("value"))
            .cloned()
            .ok_or_else(|| invalid_argument("tokenGuard.set expects { key, value }"))?;
        write_change(state, args, Change::Set(key, value)).await
    })
}

fn token_guard_reset(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let key = key_arg(&args, "tokenGuard.reset")?;
        write_change(state, args, Change::Reset(key)).await
    })
}

fn token_guard_reset_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { write_change(state, args, Change::ResetAll).await })
}

// Tests live in a sibling file, as in `model_roles.rs`.
#[cfg(test)]
#[path = "token_guard_tests.rs"]
mod tests;
