// The pure half of `checklist.itemMessage`: validate the call, change the checklist where the
// action does, write the send record and build the turn text. The caller holds the Session lock and
// sends the text only after this returns, so the state and its record are stored before the send.

use super::developer_ops::{apply_developer, check_item_unseen_agent_change};
use super::model::{
    Actor, Checklist, ChecklistFile, ItemOwner, ItemStatus, SendAction, MAX_ITEM_MESSAGE_BYTES,
    MAX_VALUE_BYTES,
};
use super::ops::{find, ChecklistError, ChecklistOp, ErrorCode};
use super::records::{accept_complete, add_send_record};
use crate::agent_tools::checklist_envelope::{complete_body, wrap};

/// An accepted call: the checklist as it now stands, the `rev` the turn and its record carry, and
/// the exact turn text to send. `changed` is false for `ask`, which touches nothing but the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub checklist: Checklist,
    pub rev: u64,
    pub text: String,
    pub changed: bool,
}

/// Applies one item action to `file`. On any error `file` is left exactly as it was.
pub fn prepare(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    base_rev: u64,
    action: SendAction,
    text: Option<&str>,
) -> Result<Prepared, ChecklistError> {
    find(active_list(file, checklist_id)?, item_id)?;
    match action {
        SendAction::Ask => ask(file, checklist_id, item_id, text),
        SendAction::Value => value(file, checklist_id, item_id, base_rev, text),
        SendAction::Complete => complete(file, checklist_id, item_id, base_rev),
    }
}

fn active_list<'a>(
    file: &'a ChecklistFile,
    checklist_id: &str,
) -> Result<&'a Checklist, ChecklistError> {
    file.active
        .as_ref()
        .filter(|list| list.id == checklist_id)
        .ok_or_else(|| ChecklistError::field(ErrorCode::InvalidInput, "checklistId"))
}

/// The developer's own words: blank is refused, and the cap here names `text`, not the item's
/// `value` field that `setValue` would report.
fn checked_text(text: Option<&str>, cap: usize) -> Result<&str, ChecklistError> {
    let body = text
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| ChecklistError::field(ErrorCode::InvalidInput, "text"))?;
    if body.len() > cap {
        return Err(ChecklistError::field(ErrorCode::TooLarge, "text"));
    }
    Ok(body)
}

fn ask(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    text: Option<&str>,
) -> Result<Prepared, ChecklistError> {
    let body = checked_text(text, MAX_ITEM_MESSAGE_BYTES)?;
    let list = active_list(file, checklist_id)?;
    let rev = list.rev;
    let checklist = list.clone();
    let turn = wrap(checklist_id, item_id, rev, SendAction::Ask, body);
    add_send_record(file, checklist_id, item_id, rev, SendAction::Ask, &turn);
    Ok(Prepared {
        checklist,
        rev,
        text: turn,
        changed: false,
    })
}

fn value(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    base_rev: u64,
    text: Option<&str>,
) -> Result<Prepared, ChecklistError> {
    let body = checked_text(text, MAX_VALUE_BYTES)?;
    let op = ChecklistOp::SetValue {
        id: item_id.to_string(),
        value: body.to_string(),
    };
    let next = apply_developer(active_list(file, checklist_id)?, base_rev, &op)?.checklist;
    let rev = next.rev;
    let turn = wrap(checklist_id, item_id, rev, SendAction::Value, body);
    file.active = Some(next.clone());
    add_send_record(file, checklist_id, item_id, rev, SendAction::Value, &turn);
    Ok(Prepared {
        checklist: next,
        rev,
        text: turn,
        changed: true,
    })
}

fn complete(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    base_rev: u64,
) -> Result<Prepared, ChecklistError> {
    let list = active_list(file, checklist_id)?;
    let item = &list.items[find(list, item_id)?];
    let pending = file
        .pending_complete
        .iter()
        .any(|e| e.checklist_id == checklist_id && e.item_id == item_id);
    if !item.agent_completable
        || item.owner == ItemOwner::Human
        || item.status == ItemStatus::Complete
        || pending
    {
        return Err(ChecklistError::item(
            ErrorCode::NotAgentCompletable,
            item_id,
        ));
    }
    // An agent-set value does not count: the agent could never complete such an item.
    if item.requires_value && item.value_by != Some(Actor::Developer) {
        return Err(ChecklistError::item(ErrorCode::ValueRequired, item_id));
    }
    check_item_unseen_agent_change(list, base_rev, item_id)?;
    // Developer-edited text must never be labelled as the agent's own.
    let agent_wrote = item.created_by == Actor::Agent && !item.edited_by_developer;
    let step = item.text.clone();
    let (rev, turn) = accept_complete(file, item_id, |rev| {
        wrap(
            checklist_id,
            item_id,
            rev,
            SendAction::Complete,
            &complete_body(&step, agent_wrote),
        )
    })
    .ok_or_else(|| ChecklistError::item(ErrorCode::NotAgentCompletable, item_id))?;
    let checklist = active_list(file, checklist_id)?.clone();
    Ok(Prepared {
        checklist,
        rev,
        text: turn,
        changed: true,
    })
}

#[cfg(test)]
#[path = "item_message.test.rs"]
mod tests;
