// Agent authority and all-or-none apply. The agent has bounded authority
// over what the developer wrote or filled in, and a completed item is frozen for it.

use super::model::{Actor, Checklist, ChecklistItem, ItemOwner, ItemStatus};
use super::ops::{
    add_item, bump_rev, check_op_count, edit_item, find, move_item, reject_locked, remove_item,
    set_status, set_value, Applied, ChecklistError, ChecklistOp, ErrorCode,
};

/// Applies an agent's op batch to a checklist all-or-none under agent authority.
pub fn apply_agent(
    list: &Checklist,
    base_rev: u64,
    ops: &[ChecklistOp],
) -> Result<Applied, ChecklistError> {
    check_op_count(ops.len())?;
    check_conflicts(list, base_rev, ops)?;
    // Ops run on a clone so the first failing op leaves the caller's checklist untouched.
    let mut next = list.clone();
    let rev = bump_rev(&mut next);
    let mut added_ids = Vec::new();
    for op in ops {
        apply_one(&mut next, op, rev, &mut added_ids)?;
    }
    Ok(Applied {
        checklist: next,
        added_ids,
    })
}

/// Checked against the checklist as the agent last saw it: an item stamped above `base_rev` was
/// changed by someone since, and the whole call fails listing every such item.
fn check_conflicts(
    list: &Checklist,
    base_rev: u64,
    ops: &[ChecklistOp],
) -> Result<(), ChecklistError> {
    let mut changed: Vec<String> = Vec::new();
    for id in ops.iter().filter_map(ChecklistOp::target_id) {
        let stale = list.items.iter().any(|i| i.id == id && i.rev > base_rev);
        if stale && !changed.iter().any(|c| c == id) {
            changed.push(id.to_string());
        }
    }
    if changed.is_empty() {
        Ok(())
    } else {
        Err(ChecklistError::items(ErrorCode::Conflict, changed))
    }
}

fn is_developer_owned(item: &ChecklistItem) -> bool {
    item.created_by == Actor::Developer || item.edited_by_developer
}

fn has_developer_value(item: &ChecklistItem) -> bool {
    item.value_by == Some(Actor::Developer)
}

fn frozen(item: &ChecklistItem) -> Result<(), ChecklistError> {
    if item.status == ItemStatus::Complete {
        return Err(ChecklistError::item(ErrorCode::ItemComplete, &item.id));
    }
    Ok(())
}

/// An agent-set value does not count: the agent could otherwise satisfy its own gate.
fn complete_allowed(item: &ChecklistItem) -> Result<(), ChecklistError> {
    if item.owner == ItemOwner::Human {
        return Err(ChecklistError::item(ErrorCode::HumanOwned, &item.id));
    }
    if item.requires_value && !has_developer_value(item) {
        return Err(ChecklistError::item(ErrorCode::ValueRequired, &item.id));
    }
    Ok(())
}

fn apply_one(
    list: &mut Checklist,
    op: &ChecklistOp,
    rev: u64,
    added_ids: &mut Vec<String>,
) -> Result<(), ChecklistError> {
    match op {
        ChecklistOp::Add { after, item } => {
            let id = add_item(list, after.as_deref(), item, rev, Actor::Agent)?;
            added_ids.push(id);
        }
        ChecklistOp::Edit {
            id, text, group, ..
        } => {
            let at = find(list, id)?;
            frozen(&list.items[at])?;
            reject_locked(op)?;
            if is_developer_owned(&list.items[at]) {
                return Err(ChecklistError::item(ErrorCode::DeveloperItem, id));
            }
            edit_item(
                &mut list.items[at],
                text.as_deref(),
                group.as_deref(),
                rev,
                Actor::Agent,
            )?;
        }
        ChecklistOp::Move { id, after } => {
            frozen(&list.items[find(list, id)?])?;
            move_item(list, id, after.as_deref(), rev, Actor::Agent)?;
        }
        ChecklistOp::Remove { id } => {
            let item = &list.items[find(list, id)?];
            frozen(item)?;
            if is_developer_owned(item) || has_developer_value(item) {
                return Err(ChecklistError::item(ErrorCode::DeveloperItem, id));
            }
            remove_item(list, id, rev, Actor::Agent)?;
        }
        ChecklistOp::SetStatus { id, status } => {
            let at = find(list, id)?;
            frozen(&list.items[at])?;
            if *status == ItemStatus::Complete {
                complete_allowed(&list.items[at])?;
            }
            set_status(&mut list.items[at], *status, rev, Actor::Agent);
        }
        ChecklistOp::SetValue { id, value } => {
            let at = find(list, id)?;
            frozen(&list.items[at])?;
            if has_developer_value(&list.items[at]) {
                return Err(ChecklistError::item(ErrorCode::DeveloperItem, id));
            }
            set_value(&mut list.items[at], value, rev, Actor::Agent)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_ops.test.rs"]
mod tests;
