// `usage.getPrefs`/`usage.setPrefs`. Only whitelisted keys in the `prefs` table are accepted.

use serde_json::{json, Value};

use super::usage::{filters_json, parse_filters};
use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, HandlerResult, IpcError};
use crate::usage::queries::Filters;
use crate::usage::{paths, schema};

const KEY_JOKES: &str = "jokes";
const KEY_FILTERS: &str = "filters";
// The Session usage panel's two toggles; the values are allowlisted so the table never holds free text.
const KEY_SESSION_SCOPE: &str = "sessionScope";
const KEY_SESSION_RANGE: &str = "sessionRange";
const SESSION_SCOPES: [&str; 2] = ["session", "conversation"];
const SESSION_RANGES: [&str; 2] = ["all", "today"];

pub fn register(d: &mut Dispatcher) {
    d.register("usage.getPrefs", usage_get_prefs);
    d.register("usage.setPrefs", usage_set_prefs);
}

fn db_error(e: impl std::fmt::Display) -> IpcError {
    IpcError::new("usage-db-unavailable", e.to_string())
}

/// A stored allowlisted value, or `default` when absent or no longer allowed.
fn read_choice(
    conn: &rusqlite::Connection,
    key: &str,
    allowed: &[&'static str],
    default: &'static str,
) -> Result<&'static str, IpcError> {
    let stored = schema::prefs_get(conn, key).map_err(db_error)?;
    Ok(allowed
        .iter()
        .copied()
        .find(|a| stored.as_deref() == Some(*a))
        .unwrap_or(default))
}

/// A patch value that must be one of `allowed`; `None` when the key is absent.
fn patch_choice<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<Option<&'a str>, IpcError> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Ok(Some(s)),
        Some(_) => Err(invalid_argument(format!(
            "usage.setPrefs: {key} must be one of {allowed:?}"
        ))),
    }
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
    let session_scope = read_choice(&conn, KEY_SESSION_SCOPE, &SESSION_SCOPES, "session")?;
    let session_range = read_choice(&conn, KEY_SESSION_RANGE, &SESSION_RANGES, "all")?;
    Ok(json!({
        "jokes": jokes,
        "filters": filters_json(&filters),
        "sessionScope": session_scope,
        "sessionRange": session_range,
    }))
}

fn write_prefs(patch: &Value) -> HandlerResult {
    let obj = patch
        .as_object()
        .ok_or_else(|| invalid_argument("usage.setPrefs: expected an object"))?;
    if obj
        .keys()
        .any(|k| !["jokes", "filters", KEY_SESSION_SCOPE, KEY_SESSION_RANGE].contains(&k.as_str()))
    {
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
    let session_scope = patch_choice(obj, KEY_SESSION_SCOPE, &SESSION_SCOPES)?;
    let session_range = patch_choice(obj, KEY_SESSION_RANGE, &SESSION_RANGES)?;
    let conn = schema::open_db(&paths::usage_db_path()).map_err(db_error)?;
    if let Some(b) = jokes {
        schema::prefs_set(&conn, KEY_JOKES, if b { "true" } else { "false" }).map_err(db_error)?;
    }
    if let Some(f) = filters {
        schema::prefs_set(&conn, KEY_FILTERS, &filters_json(&f).to_string()).map_err(db_error)?;
    }
    if let Some(s) = session_scope {
        schema::prefs_set(&conn, KEY_SESSION_SCOPE, s).map_err(db_error)?;
    }
    if let Some(s) = session_range {
        schema::prefs_set(&conn, KEY_SESSION_RANGE, s).map_err(db_error)?;
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
