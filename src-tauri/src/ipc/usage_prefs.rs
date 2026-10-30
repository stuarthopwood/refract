// Spec 060 (#1331) `usage.getPrefs` / `usage.setPrefs`: the jokes toggle and the last-used
// filters, stored in the `prefs` table of `usage.db`. Only whitelisted keys are accepted.

use serde_json::{json, Value};

use super::usage::{filters_json, parse_filters};
use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, HandlerResult, IpcError};
use crate::usage::queries::Filters;
use crate::usage::{paths, schema};

const KEY_JOKES: &str = "jokes";
const KEY_FILTERS: &str = "filters";

pub fn register(d: &mut Dispatcher) {
    d.register("usage.getPrefs", usage_get_prefs);
    d.register("usage.setPrefs", usage_set_prefs);
}

fn db_error(e: impl std::fmt::Display) -> IpcError {
    IpcError::new("usage-db-unavailable", e.to_string())
}

fn read_prefs() -> HandlerResult {
    let conn = schema::open_db(&paths::usage_db_path()).map_err(db_error)?;
    let jokes = schema::prefs_get(&conn, KEY_JOKES)
        .map_err(db_error)?
        .is_none_or(|v| v != "false");
    let stored = schema::prefs_get(&conn, KEY_FILTERS)
        .map_err(db_error)?
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| parse_filters(Some(&v)).ok());
    let filters = stored.unwrap_or_else(|| Filters {
        range: "30d".into(),
        ..Filters::default()
    });
    Ok(json!({ "jokes": jokes, "filters": filters_json(&filters) }))
}

fn write_prefs(patch: &Value) -> HandlerResult {
    let obj = patch
        .as_object()
        .ok_or_else(|| invalid_argument("usage.setPrefs: expected an object"))?;
    if obj.keys().any(|k| k != "jokes" && k != "filters") {
        return Err(invalid_argument("usage.setPrefs: unknown key"));
    }
    let jokes = match obj.get("jokes") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(invalid_argument("usage.setPrefs: jokes must be a boolean")),
    };
    let filters = obj
        .get("filters")
        .map(|v| parse_filters(Some(v)))
        .transpose()?;
    let conn = schema::open_db(&paths::usage_db_path()).map_err(db_error)?;
    if let Some(b) = jokes {
        schema::prefs_set(&conn, KEY_JOKES, if b { "true" } else { "false" }).map_err(db_error)?;
    }
    if let Some(f) = filters {
        schema::prefs_set(&conn, KEY_FILTERS, &filters_json(&f).to_string()).map_err(db_error)?;
    }
    read_prefs()
}

fn usage_get_prefs(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(read_prefs)
            .await
            .map_err(db_error)?
    })
}

fn usage_set_prefs(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let patch = args.first().cloned().unwrap_or(Value::Null);
        tokio::task::spawn_blocking(move || write_prefs(&patch))
            .await
            .map_err(db_error)?
    })
}
