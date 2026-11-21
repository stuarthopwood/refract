// `checklist.itemMessage`: the developer's ask, value or "complete this step" for one item. The
// state change and the send record are stored before the turn goes out, so a turn that reaches the
// transcript always finds its record; a refused send undoes both.

use std::future::Future;

use serde_json::{json, Value};

use super::checklist::{live_session, refusal, store_error, AppHost, Host};
use super::{arg_str, invalid_argument, IpcError};
use crate::checklist::item_message::prepare;
use crate::checklist::model::{Actor, SendAction};
use crate::checklist::records::{clear_resolved, refuse_complete, remove_send_record};
use crate::checklist::store::StoreError;
use crate::events::checklist_update_payload;
use crate::session::agent::{outcome_name, MessageDelivery};
use crate::session::AgentError;

/// The Session's agent, which `Host` does not need for the panel's own edits.
pub trait ItemHost: Host {
    fn has_agent(&self, id: &str) -> bool;
    /// Sends the finished turn text; an agent that vanished since `has_agent` is an error.
    fn deliver(
        &self,
        id: &str,
        text: String,
    ) -> impl Future<Output = Result<MessageDelivery, AgentError>> + Send;
}

fn action_of(name: &str) -> Option<SendAction> {
    match name {
        "ask" => Some(SendAction::Ask),
        "value" => Some(SendAction::Value),
        "complete" => Some(SendAction::Complete),
        _ => None,
    }
}

/// One item action. Every action needs a live agent: with none, a value is saved through
/// `checklist.mutate` instead, so nothing is stored here for a turn that cannot be sent.
pub async fn item_message_with(
    host: &impl ItemHost,
    session_id: &str,
    checklist_id: &str,
    item_id: &str,
    base_rev: u64,
    action: SendAction,
    text: Option<String>,
) -> Result<Value, IpcError> {
    let live = live_session(host, session_id).await?;
    if !host.has_agent(session_id) {
        return Err(IpcError::new(
            "agent-not-running",
            "This Session has no live agent to receive the message",
        ));
    }
    let (wanted, item) = (checklist_id.to_string(), item_id.to_string());
    let emit = host.emitter();
    let session = session_id.to_string();
    let prepared = host
        .store()
        .apply_detached_then(
            live,
            move |file| {
                let out = prepare(file, &wanted, &item, base_rev, action, text.as_deref())?;
                clear_resolved(file);
                Ok(out)
            },
            move |out| {
                if out.changed {
                    emit(checklist_update_payload(
                        &session,
                        &out.checklist,
                        Actor::Developer,
                        false,
                    ));
                }
            },
        )
        .await;
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(StoreError::Op(e)) => return refusal(host, session_id, &e).await,
        Err(other) => return Err(store_error(other, session_id)),
    };
    match host.deliver(session_id, prepared.text.clone()).await {
        Ok(delivery) => Ok(json!({
            "delivery": outcome_name(delivery),
            "checklist": prepared.checklist,
        })),
        Err(err) => {
            // `prompt-failed` tells the panel the value is saved; `restore-failed` says the undo itself failed, so the item may not be as it was.
            let refused = IpcError::new("prompt-failed", err.message);
            match undo_send(host, session_id, checklist_id, item_id, action, &prepared).await {
                Ok(()) => Err(refused),
                Err(undo) => Err(IpcError::new(
                    "restore-failed",
                    format!(
                        "{} The item could not be restored: {}",
                        refused.message, undo.message
                    ),
                )),
            }
        }
    }
}

/// A refused send leaves no record. A refused "complete" also gives the item its status back;
/// a refused value keeps the value, which was the developer's own edit.
async fn undo_send(
    host: &impl ItemHost,
    session_id: &str,
    checklist_id: &str,
    item_id: &str,
    action: SendAction,
    prepared: &crate::checklist::item_message::Prepared,
) -> Result<(), IpcError> {
    let live = live_session(host, session_id).await?;
    let emit = host.emitter();
    let session = session_id.to_string();
    let (checklist_id, item_id) = (checklist_id.to_string(), item_id.to_string());
    let (rev, text) = (prepared.rev, prepared.text.clone());
    host.store()
        .apply_detached_then(
            live,
            move |file| {
                if action == SendAction::Complete {
                    let restored = refuse_complete(file, &item_id);
                    return Ok(restored.then(|| file.active.clone()).flatten());
                }
                remove_send_record(file, &checklist_id, &item_id, rev, action, &text);
                Ok(None)
            },
            move |restored| {
                if let Some(list) = restored {
                    emit(checklist_update_payload(
                        &session,
                        list,
                        Actor::Developer,
                        false,
                    ));
                }
            },
        )
        .await
        .map_err(|err| {
            log::warn!("checklist: could not undo a refused item send: {err:?}");
            store_error(err, session_id)
        })?;
    Ok(())
}

impl ItemHost for AppHost<'_> {
    fn has_agent(&self, id: &str) -> bool {
        self.state.session_manager.get_agent(id).is_some()
    }
    async fn deliver(&self, id: &str, text: String) -> Result<MessageDelivery, AgentError> {
        match self.state.session_manager.get_agent(id) {
            Some(agent) => agent.send_checklist_item(text).await,
            None => Err(AgentError::new(
                "agent-not-running",
                "This Session has no live agent to receive the message",
            )),
        }
    }
}

pub fn register(d: &mut super::Dispatcher) {
    d.register("checklist.itemMessage", checklist_item_message);
}

fn checklist_item_message(state: super::AppState, mut args: Vec<Value>) -> super::HandlerFuture {
    Box::pin(async move {
        const SHAPE: &str = "checklist.itemMessage expects (sessionId, checklistId, itemId, baseRev, action, text?)";
        let text = match args.get_mut(5).map(Value::take) {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text),
            Some(_) => return Err(invalid_argument(SHAPE)),
        };
        let (Some(session_id), Some(checklist_id), Some(item_id), Some(base_rev), Some(action)) = (
            arg_str(&args, 0),
            arg_str(&args, 1),
            arg_str(&args, 2),
            args.get(3).and_then(Value::as_u64),
            arg_str(&args, 4).and_then(action_of),
        ) else {
            return Err(invalid_argument(SHAPE));
        };
        let host = AppHost { state: &state };
        item_message_with(
            &host,
            session_id,
            checklist_id,
            item_id,
            base_rev,
            action,
            text,
        )
        .await
    })
}

#[cfg(test)]
#[path = "checklist_item.test.rs"]
mod tests;
