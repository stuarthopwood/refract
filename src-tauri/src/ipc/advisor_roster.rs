// `advisorRoster.detect/open` (#1409). The renderer sends at most a Session id, never a path, so
// `open` only ever opens the roster file the detector itself finds.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::omp::advisor_roster::{self, Roster};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("advisorRoster.detect", advisor_roster_detect);
    d.register("advisorRoster.open", advisor_roster_open);
}

async fn detect(state: &AppState, args: &[Value]) -> Result<Option<Roster>, IpcError> {
    let cwd = match args.first() {
        None | Some(Value::Null) => None,
        Some(Value::String(session_id)) => {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(session_id)
                .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
            Some(PathBuf::from(&session.worktree_path))
        }
        Some(_) => {
            return Err(invalid_argument(
                "advisorRoster expects an optional string sessionId",
            ))
        }
    };
    Ok(advisor_roster::detect_for(cwd).await)
}

fn advisor_roster_detect(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(json!(detect(&state, &args).await?)) })
}

fn advisor_roster_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let roster = detect(&state, &args)
            .await?
            .ok_or_else(|| not_found("No advisor roster file found."))?;
        let path = PathBuf::from(&roster.path);
        let target = advisor_roster::openable_target(&path)
            .ok_or_else(|| not_found("No advisor roster file found."))?;
        let opened = tokio::task::spawn_blocking(move || {
            tauri_plugin_opener::open_path(target.to_string_lossy().into_owned(), None::<&str>)
        })
        .await
        .map_err(|err| IpcError::new("open-failed", err.to_string()))?;
        opened.map_err(|err| IpcError::new("open-failed", err.to_string()))?;
        Ok(Value::Null)
    })
}
