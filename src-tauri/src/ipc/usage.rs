// Spec 060 (#1331) `usage.*` handlers. A renderer value is only ever a filter (range and bounded
// strings that become bound SQL parameters), a sort key from an allowlist, a page number, or a
// time-zone offset; nothing here takes a path or SQL fragment, and no result carries prompt prose.
// The Usage worker's nudge path comes from the registry (`nudge`), never from the renderer.

use std::sync::{Arc, OnceLock};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, HandlerResult, IpcError};
use crate::usage::project_label::{normalise_path, ProjectIndex};
use crate::usage::queries::{self, Filters, QueryCtx, QueryError, MAX_TZ_MINUTES};
use crate::usage::queries_tables::{self, BreakdownBy, Page, Sort, MAX_PAGE_SIZE};
use crate::usage::{budget, UsageService, UsageStatus};

const MAX_FILTER_TEXT: usize = 200;
const MAX_PAGE_INDEX: i64 = 1_000_000;

static SERVICE: OnceLock<Arc<UsageService>> = OnceLock::new();

pub fn register(d: &mut Dispatcher) {
    d.register("usage.start", usage_start);
    d.register("usage.stop", usage_stop);
    d.register("usage.status", usage_status);
    d.register("usage.summary", usage_summary);
    d.register("usage.timeseries", usage_timeseries);
    d.register("usage.tokenMix", usage_token_mix);
    d.register("usage.breakdown", usage_breakdown);
    d.register("usage.topSessions", usage_top_sessions);
    d.register("usage.calls", usage_calls);
    d.register("usage.frustration", usage_frustration);
    d.register("usage.budget", usage_budget);
    super::usage_prefs::register(d);
}

/// The worker is created on the first `usage.start`; until then there is nothing to nudge.
fn service(state: &AppState) -> Arc<UsageService> {
    SERVICE
        .get_or_init(|| {
            let app = state.app_handle.clone();
            let emit: crate::usage::StatusEmit = Arc::new(move |status: &UsageStatus| {
                let handle = app.lock().ok().and_then(|guard| guard.clone());
                if let Some(handle) = handle {
                    crate::events::emit(&handle, crate::events::USAGE_PROGRESS, status.clone());
                }
            });
            let registry = state.registry.clone();
            let projects: crate::usage::ProjectsProvider = Arc::new(move || {
                // Runs on the usage worker thread, never inside the tokio runtime.
                ProjectIndex::from_registry(&registry.blocking_lock().snapshot())
            });
            Arc::new(UsageService::new(emit, projects))
        })
        .clone()
}

/// Called from `session::usage_nudge` when a Refract Session finishes a message. A no-op until
/// the Usage view has started the worker.
pub fn nudge(path: &std::path::Path) {
    if let Some(service) = SERVICE.get() {
        service.nudge(path);
    }
}

fn db_unavailable(reason: impl std::fmt::Display) -> IpcError {
    IpcError::new("usage-db-unavailable", reason.to_string())
}

fn query_error(err: QueryError) -> IpcError {
    match err {
        QueryError::InvalidArgument(message) => invalid_argument(message),
        QueryError::Db(e) => db_unavailable(e),
    }
}

fn to_json<T: Serialize>(value: &T) -> HandlerResult {
    serde_json::to_value(value).map_err(|e| IpcError::new("usage-db-unavailable", e.to_string()))
}

fn usage_start(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let service = service(&state);
        service.start();
        to_json(&service.status())
    })
}

fn usage_stop(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        if let Some(service) = SERVICE.get() {
            service.stop();
        }
        Ok(Value::Null)
    })
}

fn usage_status(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { to_json(&service(&state).status()) })
}

/// Checks the text bounds and the range and agent-type allowlists; the SQL layer parameterises
/// the rest.
pub(super) fn validate_filters(filters: &Filters) -> Result<(), IpcError> {
    filters.validate().map_err(query_error)?;
    let texts = [&filters.project, &filters.model, &filters.reasoning];
    if texts.iter().any(|t| {
        t.as_deref()
            .is_some_and(|s| s.chars().count() > MAX_FILTER_TEXT)
    }) {
        return Err(invalid_argument(
            "usage filters: a filter value is too long",
        ));
    }
    Ok(())
}

pub(super) fn parse_filters(value: Option<&Value>) -> Result<Filters, IpcError> {
    let value = value.ok_or_else(|| invalid_argument("usage: filters is required"))?;
    let filters: Filters = serde_json::from_value(value.clone())
        .map_err(|e| invalid_argument(format!("usage: bad filters ({e})")))?;
    validate_filters(&filters)?;
    Ok(filters)
}

/// The renderer sends `Date.getTimezoneOffset()` (minutes WEST of UTC); `QueryCtx` wants minutes
/// EAST. This is the one place the sign flips. Absent or null means UTC.
fn query_ctx(tz_west: Option<&Value>) -> Result<QueryCtx, IpcError> {
    let west = match tz_west {
        None | Some(Value::Null) => 0,
        Some(value) => value
            .as_i64()
            .filter(|v| v.abs() <= MAX_TZ_MINUTES)
            .ok_or_else(|| {
                invalid_argument("usage: tzOffsetMinutes must be a whole number of minutes")
            })?,
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    Ok(QueryCtx {
        now_ms,
        tz_offset_minutes: -west,
    })
}

async fn read<T, F>(run: F) -> Result<T, IpcError>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, QueryError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let conn = crate::usage::open_reader().map_err(db_unavailable)?;
        run(&conn).map_err(query_error)
    })
    .await
    .map_err(db_unavailable)?
}

fn usage_summary(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let ctx = query_ctx(args.get(1))?;
        to_json(&read(move |c| queries::summary(c, &filters, &ctx)).await?)
    })
}

fn usage_timeseries(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let hourly = match args.get(1).and_then(Value::as_str) {
            Some("day") => false,
            Some("hour") => true,
            _ => {
                return Err(invalid_argument(
                    "usage.timeseries: bucket must be 'day' or 'hour'",
                ))
            }
        };
        let ctx = query_ctx(args.get(2))?;
        to_json(&read(move |c| queries::timeseries(c, &filters, hourly, &ctx)).await?)
    })
}

fn usage_token_mix(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let ctx = query_ctx(args.get(1))?;
        to_json(&read(move |c| queries::token_mix(c, &filters, &ctx)).await?)
    })
}

fn usage_breakdown(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let by = BreakdownBy::parse(args.get(1).and_then(Value::as_str).unwrap_or_default())
            .map_err(query_error)?;
        let ctx = query_ctx(args.get(2))?;
        to_json(&read(move |c| queries_tables::breakdown(c, &filters, by, &ctx)).await?)
    })
}

fn usage_top_sessions(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let ctx = query_ctx(args.get(1))?;
        let rows = read(move |c| queries_tables::top_sessions(c, &filters, &ctx)).await?;
        let session_dirs: Vec<String> = state
            .registry
            .lock()
            .await
            .snapshot()
            .sessions
            .iter()
            .filter_map(|s| s.session_dir.as_deref().map(normalise_path))
            .collect();
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut value = to_json(row)?;
            // A Conversation file lives in its Session's own session directory.
            let parent = std::path::Path::new(&row.session_file)
                .parent()
                .map(|p| normalise_path(&p.to_string_lossy()))
                .unwrap_or_default();
            let known = !parent.is_empty() && session_dirs.contains(&parent);
            if let Value::Object(map) = &mut value {
                map.insert("conversationKnown".into(), Value::Bool(known));
            }
            out.push(value);
        }
        Ok(Value::Array(out))
    })
}

fn usage_calls(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let sort: Sort = serde_json::from_value(args.get(1).cloned().unwrap_or(Value::Null))
            .map_err(|_| invalid_argument("usage.calls: sort must be { key, dir }"))?;
        let page: Page = serde_json::from_value(args.get(2).cloned().unwrap_or(Value::Null))
            .map_err(|_| invalid_argument("usage.calls: page must be { index, size }"))?;
        if page.size < 1
            || page.size > MAX_PAGE_SIZE
            || page.index < 0
            || page.index > MAX_PAGE_INDEX
        {
            return Err(invalid_argument(format!(
                "usage.calls: page size must be 1 to {MAX_PAGE_SIZE}"
            )));
        }
        let ctx = query_ctx(args.get(3))?;
        to_json(&read(move |c| queries_tables::calls(c, &filters, &sort, page, &ctx)).await?)
    })
}

fn usage_frustration(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let filters = parse_filters(args.first())?;
        let ctx = query_ctx(args.get(1))?;
        to_json(&read(move |c| queries::frustration(c, &filters, &ctx)).await?)
    })
}

fn usage_budget(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { to_json(&budget::budget().await) })
}

/// A filters value in the contract's `UsageFilters` shape, for `usage.getPrefs`.
pub(super) fn filters_json(f: &Filters) -> Value {
    json!({
        "range": f.range,
        "from": f.from,
        "to": f.to,
        "project": f.project,
        "model": f.model,
        "reasoning": f.reasoning,
        "agentType": f.agent_type,
    })
}
