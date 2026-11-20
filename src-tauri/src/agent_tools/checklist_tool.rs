// `refract_checklist`: create, update and get the Session's checklist. The Session is the caller's
// own, taken from the registry; no argument can name another. The core is generic over `Host` so
// the card, the ordering of the update event and cancellation are testable.

use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::approval;
use super::checklist_schema::CHECKLIST;
use super::router::{ToolError, INVALID_INPUT};
use crate::checklist::changes::{acknowledge, issue_seen_rev, user_changes};
use crate::checklist::create::{
    check_request_id, create, is_structural, record_request, recorded_ids, CreateArgs,
    CreateOutcome,
};
use crate::checklist::model::{Actor, Checklist, ChecklistFile};
use crate::checklist::ops::{decode_ops, ChecklistError, ErrorCode, NewItem};
use crate::checklist::result::{build_result, error_payload, none_result, ResultInput};
use crate::checklist::store::{ChecklistStore, LiveSession, StoreError};
use crate::events::checklist_update_payload;

/// Everything the handler needs from the app, so tests supply a fake.
pub trait Host: Send + Sync {
    /// The calling Session, known to Rust from the registry.
    fn caller_id(&self) -> &str;
    fn store(&self) -> &Arc<ChecklistStore>;
    fn is_live(&self, id: &str) -> impl Future<Output = bool> + Send;
    fn is_deleting(&self, id: &str) -> bool;
    /// Raises the card and waits for the developer.
    fn ask(
        &self,
        card: crate::session::agent::PendingRequest,
    ) -> impl Future<Output = Result<(), ToolError>> + Send;
    /// `checklist:update`; called only after the write reached disk.
    fn emit_update(&self, payload: Value);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Args {
    action: String,
    request_id: Option<String>,
    title: Option<String>,
    items: Option<Vec<NewItem>>,
    replace: Option<bool>,
    base_rev: Option<u64>,
    ops: Option<Vec<Value>>,
    item_id: Option<String>,
    full: Option<bool>,
    after: Option<String>,
}

/// What a store call produced: a result for the agent, and whether it changed the checklist.
enum Outcome {
    NoActive,
    NeedsCard(usize),
    Done {
        value: Value,
        checklist: Box<Checklist>,
        wrote: bool,
        opened: bool,
    },
}

fn invalid(field: &'static str) -> Value {
    error_payload(&ChecklistError::field(ErrorCode::InvalidInput, field), None)
}

fn store_error(error: StoreError) -> ToolError {
    let (code, message) = match error {
        StoreError::UnknownSession | StoreError::Tombstoned => {
            ("session_gone", "this Session no longer exists")
        }
        StoreError::SessionDeleting => ("session_gone", "this Session is being deleted"),
        StoreError::StoreUnsupported => (
            "store_unsupported",
            "the checklist file was written by a newer version",
        ),
        StoreError::StoreFailed(_) => ("store_failed", "the checklist could not be saved"),
        StoreError::Op(_) => ("store_failed", "the checklist could not be saved"),
    };
    ToolError::new(code, message)
}

fn full_result(
    list: &Checklist,
    duplicate: bool,
    assigned: Option<(&'static str, &[String])>,
) -> Value {
    let changes = user_changes(list);
    build_result(&ResultInput {
        list,
        duplicate,
        assigned,
        items: list.items.iter().collect(),
        full: false,
        changes: &changes,
    })
}

fn done(list: &Checklist, value: Value, wrote: bool, opened: bool) -> Outcome {
    Outcome::Done {
        value,
        checklist: Box::new(list.clone()),
        wrote,
        opened,
    }
}

fn do_create(
    file: &mut ChecklistFile,
    request_id: Option<&str>,
    title: &str,
    items: &[NewItem],
    replace: bool,
    approved: bool,
) -> Result<Outcome, ChecklistError> {
    let args = CreateArgs {
        request_id,
        title,
        items,
        replace,
    };
    match create(file, &args, approved, &crate::ipc::now_iso8601())? {
        CreateOutcome::NeedsCard { developer_items } => Ok(Outcome::NeedsCard(developer_items)),
        CreateOutcome::Duplicate { ids } => {
            let list = file
                .active
                .as_ref()
                .expect("a duplicate has an active list");
            let value = full_result(list, true, Some(("ids", &ids)));
            Ok(done(list, value, false, false))
        }
        CreateOutcome::Created { file: next, ids } => {
            *file = *next;
            let list = file.active.as_mut().expect("a created file has a list");
            let seen = user_changes(list).seen_rev;
            issue_seen_rev(list, seen);
            let value = full_result(list, false, Some(("ids", &ids)));
            Ok(done(list, value, true, true))
        }
    }
}

fn do_update(
    file: &mut ChecklistFile,
    request_id: Option<&str>,
    base_rev: u64,
    ops: &[crate::checklist::ops::ChecklistOp],
) -> Result<Outcome, ChecklistError> {
    let Some(list) = file.active.as_mut() else {
        return Ok(Outcome::NoActive);
    };
    if let Some(ids) = request_id.and_then(|id| recorded_ids(list, id)) {
        let value = full_result(list, true, Some(("addedIds", ids)));
        return Ok(done(list, value, false, false));
    }
    let applied = crate::checklist::agent_ops::apply_agent(list, base_rev, ops)?;
    let mut next = applied.checklist;
    acknowledge(&mut next, Some(base_rev));
    if let Some(id) = request_id {
        let rev = next.rev;
        record_request(&mut next, id, rev, applied.added_ids.clone());
    }
    let seen = user_changes(&next).seen_rev;
    issue_seen_rev(&mut next, seen);
    let value = full_result(&next, false, Some(("addedIds", &applied.added_ids)));
    let out = done(&next, value, true, false);
    *list = next;
    Ok(out)
}

fn do_get(
    file: &mut ChecklistFile,
    base_rev: Option<u64>,
    item_id: Option<&str>,
    after: Option<&str>,
    full: bool,
) -> Result<Outcome, ChecklistError> {
    let Some(list) = file.active.as_mut() else {
        return Ok(Outcome::NoActive);
    };
    let unknown = |id: &str| ChecklistError::item(ErrorCode::UnknownItem, id);
    let start = match after {
        Some(id) => {
            list.items
                .iter()
                .position(|i| i.id == id)
                .ok_or_else(|| unknown(id))?
                + 1
        }
        None => 0,
    };
    if let Some(id) = item_id {
        if !list.items.iter().any(|i| i.id == id) {
            return Err(unknown(id));
        }
    }
    acknowledge(list, base_rev);
    let changes = user_changes(list);
    issue_seen_rev(list, changes.seen_rev);
    let items = list.items[start..]
        .iter()
        .filter(|i| item_id.is_none_or(|id| i.id == id))
        .collect();
    let value = build_result(&ResultInput {
        list,
        duplicate: false,
        assigned: None,
        items,
        full: full || item_id.is_some(),
        changes: &changes,
    });
    Ok(done(list, value, false, false))
}

async fn live_session(host: &impl Host) -> Result<LiveSession, ToolError> {
    let id = host.caller_id();
    let live = host.is_live(id).await;
    LiveSession::check(id, |_| live, |id| host.is_deleting(id)).map_err(store_error)
}

/// The list as it stands, for an error result that lists its items.
async fn active_of(host: &impl Host, live: &LiveSession) -> Option<Checklist> {
    host.store()
        .read(live, |file| file.active.clone())
        .await
        .ok()
        .flatten()
}

/// The card for a replace: it names how many of the developer's own items would be discarded.
fn replace_card(call_id: &str, developer_items: usize) -> crate::session::agent::PendingRequest {
    approval::session_card(
        call_id,
        CHECKLIST,
        "Replace the checklist".to_string(),
        vec![format!(
            "The agent wants to archive the current checklist, which has {developer_items} unfinished item(s) you wrote or filled in."
        )],
    )
}

fn finish(host: &impl Host, outcome: Outcome) -> Result<Value, ToolError> {
    match outcome {
        Outcome::NoActive => Ok(none_result()),
        Outcome::NeedsCard(_) => Err(ToolError::new(INVALID_INPUT, "unexpected approval request")),
        Outcome::Done {
            value,
            checklist,
            wrote,
            opened,
        } => {
            if wrote {
                host.emit_update(checklist_update_payload(
                    host.caller_id(),
                    &checklist,
                    Actor::Agent,
                    opened,
                ));
            }
            Ok(value)
        }
    }
}

/// Handles one `refract_checklist` call for the caller's own Session.
pub async fn checklist_with(
    host: &impl Host,
    call_id: &str,
    args: &Value,
) -> Result<Value, ToolError> {
    let args: Args = match serde_json::from_value(args.clone()) {
        Ok(args) => args,
        Err(_) => return Ok(invalid("action")),
    };
    let live = live_session(host).await?;
    let store = host.store();
    let result = match args.action.as_str() {
        "create" => {
            let (Some(title), Some(items)) = (args.title.clone(), args.items.clone()) else {
                return Ok(invalid(if args.title.is_none() {
                    "title"
                } else {
                    "items"
                }));
            };
            let replace = args.replace.unwrap_or(false);
            let mut approved = false;
            loop {
                let (request_id, title, items) =
                    (args.request_id.clone(), title.clone(), items.clone());
                let live_again = live_session(host).await?;
                let outcome = store
                    .apply_detached(live_again, move |file| {
                        do_create(
                            file,
                            request_id.as_deref(),
                            &title,
                            &items,
                            replace,
                            approved,
                        )
                    })
                    .await;
                match outcome {
                    Ok(Outcome::NeedsCard(n)) if !approved => {
                        host.ask(replace_card(call_id, n)).await?;
                        approved = true;
                    }
                    other => break other,
                }
            }
        }
        "update" => {
            let Some(base_rev) = args.base_rev else {
                return Ok(invalid("baseRev"));
            };
            let ops = match decode_ops(args.ops.as_deref().unwrap_or_default()) {
                Ok(ops) => ops,
                Err(e) => return Ok(error_payload(&e, active_of(host, &live).await.as_ref())),
            };
            if let Err(e) = check_request_id(args.request_id.as_deref(), is_structural(&ops)) {
                return Ok(error_payload(&e, active_of(host, &live).await.as_ref()));
            }
            let request_id = args.request_id.clone();
            store
                .apply_detached(live_session(host).await?, move |file| {
                    do_update(file, request_id.as_deref(), base_rev, &ops)
                })
                .await
        }
        "get" => {
            let (base_rev, item_id, after, full) = (
                args.base_rev,
                args.item_id.clone(),
                args.after.clone(),
                args.full.unwrap_or(false),
            );
            store
                .apply_detached(live_session(host).await?, move |file| {
                    do_get(file, base_rev, item_id.as_deref(), after.as_deref(), full)
                })
                .await
        }
        _ => return Ok(invalid("action")),
    };
    match result {
        Ok(outcome) => finish(host, outcome),
        Err(StoreError::Op(e)) => Ok(error_payload(&e, active_of(host, &live).await.as_ref())),
        Err(other) => Err(store_error(other)),
    }
}

struct AppHost {
    agent: Arc<crate::session::SessionAgent>,
    call_id: String,
    store: Arc<ChecklistStore>,
}

impl Host for AppHost {
    fn caller_id(&self) -> &str {
        self.agent.tool_session_id()
    }
    fn store(&self) -> &Arc<ChecklistStore> {
        &self.store
    }
    async fn is_live(&self, id: &str) -> bool {
        let registry = self.agent.tool_registry().lock().await;
        registry.get_session(id).is_some()
    }
    fn is_deleting(&self, id: &str) -> bool {
        crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting(id)
    }
    async fn ask(&self, card: crate::session::agent::PendingRequest) -> Result<(), ToolError> {
        let rx = self
            .agent
            .tool_router()
            .wait_for(&approval::request_id(&self.call_id));
        self.agent.tool_raise_approval(card).await;
        super::router::approval_outcome(rx.await.ok())
    }
    fn emit_update(&self, payload: Value) {
        self.agent.tool_events().emit_checklist_update(payload);
    }
}

/// Entry for the router: the store is the manager's one shared store.
pub async fn checklist(
    agent: &Arc<crate::session::SessionAgent>,
    call_id: &str,
    args: &Value,
) -> Result<Value, ToolError> {
    let manager = agent
        .tool_manager()
        .ok_or_else(|| ToolError::new("session_gone", "the app is shutting down"))?;
    let host = AppHost {
        agent: agent.clone(),
        call_id: call_id.to_string(),
        store: manager.checklists().clone(),
    };
    checklist_with(&host, call_id, args).await
}

#[cfg(test)]
#[path = "checklist_tool.test.rs"]
mod tests;
