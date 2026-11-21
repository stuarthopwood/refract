// Developer apply. The same ops as the agent, without the freeze
// or the authorship limits; the developer can reopen a completed item and edit anything but the
// three fields fixed at creation.

use super::model::{Actor, Checklist, ChecklistItem, ItemStatus, LastDeveloperOp, OpKind};
use super::ops::{
    add_item, bump_rev, edit_item, find, move_item, reject_locked, remove_item, set_status,
    set_value, Applied, ChecklistError, ChecklistOp, ErrorCode,
};

/// One op per call (`checklist.mutate`). `base_rev` only guards the agent's changes: two developer
/// ops never conflict, so a stale panel can still tick.
pub fn apply_developer(
    list: &Checklist,
    base_rev: u64,
    op: &ChecklistOp,
) -> Result<Applied, ChecklistError> {
    check_agent_change(list, base_rev, op)?;
    let mut next = list.clone();
    let rev = bump_rev(&mut next);
    let mut added_ids = Vec::new();
    match op {
        ChecklistOp::Add { after, item } => {
            let id = add_item(&mut next, after.as_deref(), item, rev, Actor::Developer)?;
            let at = find(&next, &id)?;
            record(&mut next.items[at], OpKind::Add, rev, Vec::new());
            added_ids.push(id);
        }
        ChecklistOp::Edit {
            id, text, group, ..
        } => {
            let at = find(&next, id)?;
            reject_locked(op)?;
            let item = &mut next.items[at];
            let fields = edit_item(
                item,
                text.as_deref(),
                group.as_deref(),
                rev,
                Actor::Developer,
            )?;
            item.edited_by_developer = true;
            record(item, OpKind::Edit, rev, fields);
        }
        ChecklistOp::Move { id, after } => {
            move_item(&mut next, id, after.as_deref(), rev, Actor::Developer)?;
            let at = find(&next, id)?;
            record(&mut next.items[at], OpKind::Move, rev, Vec::new());
        }
        ChecklistOp::Remove { id } => {
            remove_item(&mut next, id, rev, Actor::Developer)?;
        }
        ChecklistOp::SetStatus { id, status } => {
            let at = find(&next, id)?;
            let item = &mut next.items[at];
            // Any value counts here, the agent's included; only the agent's own gate is stricter.
            if *status == ItemStatus::Complete && item.requires_value && item.value.is_none() {
                return Err(ChecklistError::item(ErrorCode::ValueRequired, id));
            }
            set_status(item, *status, rev, Actor::Developer);
            record(item, OpKind::SetStatus, rev, Vec::new());
        }
        ChecklistOp::SetValue { id, value } => {
            let at = find(&next, id)?;
            let item = &mut next.items[at];
            set_value(item, value, rev, Actor::Developer)?;
            record(item, OpKind::SetValue, rev, Vec::new());
        }
    }
    Ok(Applied {
        checklist: next,
        added_ids,
    })
}

/// Only the last toucher is known, so a developer change made after an unseen agent change hides
/// it; the agent's change is still in the panel's next `checklist:update`.
fn check_agent_change(
    list: &Checklist,
    base_rev: u64,
    op: &ChecklistOp,
) -> Result<(), ChecklistError> {
    match op.target_id() {
        Some(id) => check_item_unseen_agent_change(list, base_rev, id),
        None => Ok(()),
    }
}

/// `item_changed` when the agent touched the item after the panel's `baseRev`. The send path uses
/// it directly because `value` and `complete` act on one item without going through an op.
pub fn check_item_unseen_agent_change(
    list: &Checklist,
    base_rev: u64,
    id: &str,
) -> Result<(), ChecklistError> {
    let agent_changed = list
        .items
        .iter()
        .any(|i| i.id == id && i.rev > base_rev && i.updated_by == Actor::Agent);
    if agent_changed {
        Err(ChecklistError::item(ErrorCode::ItemChanged, id))
    } else {
        Ok(())
    }
}

/// A later op replaces only the record of its own kind, so a `move` never hides an unseen tick.
fn record(item: &mut ChecklistItem, kind: OpKind, rev: u64, fields: Vec<String>) {
    item.last_developer_ops.retain(|r| r.kind != kind);
    item.last_developer_ops
        .push(LastDeveloperOp { kind, rev, fields });
}

#[cfg(test)]
#[path = "developer_ops.test.rs"]
mod tests;
