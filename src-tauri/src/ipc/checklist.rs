// IPC for the checklist panel: `checklist.get` and `checklist.mutate`. The Session id comes from
// the renderer, so it is checked against the registry before the store sees it.

use std::future::Future;
use std::sync::Arc;

use serde_json::{json, Value};

use super::{arg_str, invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};
use crate::checklist::create::{check_request_id, record_request, recorded_ids};
use crate::checklist::developer_ops::apply_developer;
use crate::checklist::model::Actor;
use crate::checklist::ops::{decode_op, ChecklistError, ErrorCode};
use crate::checklist::result::message;
use crate::checklist::store::{ChecklistStore, LiveSession, StoreError};
use crate::events::checklist_update_payload;

/// Everything the handlers need from the app, so tests supply a fake.
pub trait Host: Send + Sync {
    fn store(&self) -> &Arc<ChecklistStore>;
    fn is_live(&self, id: &str) -> impl Future<Output = bool> + Send;
    fn is_deleting(&self, id: &str) -> bool;
    /// `checklist:update`; called only after the write reached disk.
    fn emit_update(&self, payload: Value);
}

fn store_error(error: StoreError, session_id: &str) -> IpcError {
    match error {
        StoreError::UnknownSession | StoreError::Tombstoned | StoreError::SessionDeleting => {
            not_found(format!("Session not found: {session_id}"))
        }
        StoreError::StoreUnsupported => IpcError::new(
            "store-unsupported",
            "The checklist file was written by a newer version",
        ),
        StoreError::StoreFailed(_) | StoreError::Op(_) => {
            IpcError::new("store-failed", "The checklist could not be saved")
        }
    }
}

async fn live_session(host: &impl Host, id: &str) -> Result<LiveSession, IpcError> {
    let live = host.is_live(id).await;
    LiveSession::check(id, |_| live, |id| host.is_deleting(id)).map_err(|e| store_error(e, id))
}

async fn active_of(host: &impl Host, session_id: &str) -> Result<Value, IpcError> {
    let live = live_session(host, session_id).await?;
    host.store()
        .read(&live, |file| json!(file.active))
        .await
        .map_err(|e| store_error(e, session_id))
}

/// `checklist.get`: the active checklist, or `null` when the Session has none.
pub async fn get_with(host: &impl Host, session_id: &str) -> Result<Value, IpcError> {
    active_of(host, session_id).await
}

/// A refused change is data for the panel, not a transport failure: it carries the checklist as it
/// stands so the panel can resync without another call.
async fn refusal(
    host: &impl Host,
    session_id: &str,
    err: &ChecklistError,
) -> Result<Value, IpcError> {
    Ok(json!({
        "error": { "code": err.code.as_str(), "message": message(err.code) },
        "checklist": active_of(host, session_id).await?,
    }))
}

/// `checklist.mutate`: one developer op. A repeated `request_id` returns the current checklist
/// without applying again.
pub async fn mutate_with(
    host: &impl Host,
    session_id: &str,
    checklist_id: &str,
    base_rev: u64,
    request_id: Option<String>,
    op: &Value,
) -> Result<Value, IpcError> {
    let live = live_session(host, session_id).await?;
    if let Err(e) = check_request_id(request_id.as_deref(), false) {
        return refusal(host, session_id, &e).await;
    }
    let op = match decode_op(op) {
        Ok(op) => op,
        Err(e) => return refusal(host, session_id, &e).await,
    };
    let wanted = checklist_id.to_string();
    let outcome = host
        .store()
        .apply_detached(live, move |file| {
            let list = match file.active.as_mut() {
                Some(list) if list.id == wanted => list,
                _ => {
                    return Err(ChecklistError::field(
                        ErrorCode::InvalidInput,
                        "checklistId",
                    ))
                }
            };
            if request_id
                .as_deref()
                .is_some_and(|id| recorded_ids(list, id).is_some())
            {
                return Ok((list.clone(), false));
            }
            let applied = apply_developer(list, base_rev, &op)?;
            let mut next = applied.checklist;
            if let Some(id) = request_id.as_deref() {
                let rev = next.rev;
                record_request(&mut next, id, rev, applied.added_ids);
            }
            *list = next.clone();
            Ok((next, true))
        })
        .await;
    match outcome {
        Ok((list, wrote)) => {
            if wrote {
                host.emit_update(checklist_update_payload(
                    session_id,
                    &list,
                    Actor::Developer,
                    false,
                ));
            }
            Ok(json!(list))
        }
        Err(StoreError::Op(e)) => refusal(host, session_id, &e).await,
        Err(other) => Err(store_error(other, session_id)),
    }
}

struct AppHost<'a> {
    state: &'a AppState,
}

impl Host for AppHost<'_> {
    fn store(&self) -> &Arc<ChecklistStore> {
        self.state.session_manager.checklists()
    }
    async fn is_live(&self, id: &str) -> bool {
        self.state.registry.lock().await.get_session(id).is_some()
    }
    fn is_deleting(&self, id: &str) -> bool {
        super::sessions_lifecycle::delete_in_flight::is_deleting(id)
    }
    fn emit_update(&self, payload: Value) {
        crate::events::EventSink::new(self.state.app_handle.clone(), self.state.registry.clone())
            .emit_checklist_update(payload);
    }
}

pub fn register(d: &mut Dispatcher) {
    d.register("checklist.get", checklist_get);
    d.register("checklist.mutate", checklist_mutate);
}

fn checklist_get(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = arg_str(&args, 0) else {
            return Err(invalid_argument("checklist.get expects (sessionId)"));
        };
        get_with(&AppHost { state: &state }, session_id).await
    })
}

fn checklist_mutate(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const SHAPE: &str =
            "checklist.mutate expects (sessionId, checklistId, baseRev, requestId?, op)";
        let (Some(session_id), Some(checklist_id), Some(base_rev)) = (
            arg_str(&args, 0),
            arg_str(&args, 1),
            args.get(2).and_then(Value::as_u64),
        ) else {
            return Err(invalid_argument(SHAPE));
        };
        let request_id = match args.get(3) {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => return Err(invalid_argument(SHAPE)),
        };
        let Some(op) = args.get(4) else {
            return Err(invalid_argument(SHAPE));
        };
        let host = AppHost { state: &state };
        mutate_with(&host, session_id, checklist_id, base_rev, request_id, op).await
    })
}

#[cfg(test)]
#[path = "checklist.test.rs"]
mod tests;
