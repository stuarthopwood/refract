// Builders shared by the op-engine tests. Ops are written as wire JSON so a test reads like the
// call the agent or the panel makes, and goes through the real decoder.

use serde_json::Value;

use super::model::{Actor, Checklist, ChecklistItem, ItemOwner, ItemStatus};
use super::ops::{decode_op, ChecklistOp};

/// An agent-created, agent-owned, upcoming item stamped at `rev` 1.
pub fn item(id: &str) -> ChecklistItem {
    ChecklistItem {
        id: id.to_string(),
        text: format!("step {id}"),
        status: ItemStatus::Upcoming,
        previous_status: None,
        owner: ItemOwner::Agent,
        requires_value: false,
        value: None,
        value_by: None,
        agent_completable: true,
        group: None,
        rev: 1,
        status_rev: 1,
        created_by: Actor::Agent,
        updated_by: Actor::Agent,
        completed_by: None,
        edited_by_developer: false,
        last_developer_ops: Vec::new(),
    }
}

pub fn developer_item(id: &str) -> ChecklistItem {
    ChecklistItem {
        created_by: Actor::Developer,
        updated_by: Actor::Developer,
        owner: ItemOwner::Human,
        ..item(id)
    }
}

pub fn completed(id: &str, by: Actor) -> ChecklistItem {
    ChecklistItem {
        status: ItemStatus::Complete,
        previous_status: Some(ItemStatus::InProgress),
        completed_by: Some(by),
        updated_by: by,
        ..item(id)
    }
}

/// `rev` is the highest item rev and the id counter follows the items, as after a fresh create.
pub fn checklist(items: Vec<ChecklistItem>) -> Checklist {
    let mut list = Checklist::empty("p1".into(), "plan".into(), "now".into());
    list.rev = items.iter().map(|i| i.rev).max().unwrap_or(0);
    list.next_item_seq = items.len() as u64 + 1;
    list.items = items;
    list
}

pub fn op(value: Value) -> ChecklistOp {
    decode_op(&value).unwrap()
}

pub fn get<'a>(list: &'a Checklist, id: &str) -> &'a ChecklistItem {
    list.items.iter().find(|i| i.id == id).unwrap()
}
