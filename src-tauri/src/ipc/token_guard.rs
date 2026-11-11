// `tokenGuard.get/set/reset/resetAll/dismissThresholdsReset`. No path or file content comes from the renderer.
// A change reaches running Sessions for `live` keys; the rest apply to the next launched Session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::ipc::model_roles::list_catalog_models;
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
) -> Value {
    let mut result = snapshot(&global.values);
    result["migration"] = json!(migrate::status(&state.data_dir).await);
    result["effectiveTriggers"] = json!(effective_triggers(state, global, windows).await);
    result["projectOverrides"] = json!(project_overrides(state, args).await);
    result
}

fn key_arg(args: &[Value], channel: &str) -> Result<String, IpcError> {
    args.first()
        .and_then(|arg| arg.get("key"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_argument(format!("{channel} expects {{ key }}")))
}

/// A write while the migration is pending would be overwritten when it later runs.
async fn require_migrated(state: &AppState) -> Result<(), IpcError> {
    if migrate::ensure(&state.data_dir).await {
        return Ok(());
    }
    let status = migrate::status(&state.data_dir).await;
    Err(invalid_argument(status.error.unwrap_or_else(|| {
        "The token guard migration has not finished".to_string()
    })))
}

/// Sessions launched before the migration read the legacy overlay, which beats the global config.
async fn refresh_legacy_overlays(state: &AppState, updated: &Global) {
    if let Err(err) = overlay::refresh_legacy(&state.data_dir, &updated.values).await {
        log::warn!("token guard: could not refresh the legacy overlay ({err})");
    }
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
        Ok(full_snapshot(&state, &args, &global, &windows).await)
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
        require_migrated(&state).await?;
        let updated = values::set(&key, value).await.map_err(invalid_argument)?;
        refresh_legacy_overlays(&state, &updated).await;
        let windows = context_windows(false).await;
        Ok(full_snapshot(&state, &args, &updated, &windows).await)
    })
}

fn token_guard_reset(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let key = key_arg(&args, "tokenGuard.reset")?;
        require_migrated(&state).await?;
        let updated = values::reset(&key).await.map_err(invalid_argument)?;
        refresh_legacy_overlays(&state, &updated).await;
        let windows = context_windows(false).await;
        Ok(full_snapshot(&state, &args, &updated, &windows).await)
    })
}

fn token_guard_reset_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        require_migrated(&state).await?;
        let updated = values::reset_all().await.map_err(invalid_argument)?;
        refresh_legacy_overlays(&state, &updated).await;
        let windows = context_windows(false).await;
        Ok(full_snapshot(&state, &args, &updated, &windows).await)
    })
}
