// Op decoding and the mechanics both engines share. Authority (who may do what) lives in
// `agent_ops` and `developer_ops`; this file only changes a checklist and never decides permission,
// so the two engines cannot drift on how an op takes effect.

use serde::Deserialize;
use serde_json::Value;

use super::ids::take_item_id;
use super::model::{
    Actor, Checklist, ChecklistItem, ItemOwner, ItemStatus, RemovedEntry, MAX_ITEMS, MAX_OPS,
    MAX_REMOVED,
};
use super::validate::{validate, Field, FieldError, FieldErrorKind};

/// Machine-readable reason an operation was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidInput,
    TooLarge,
    UnknownItem,
    ItemRemoved,
    Conflict,
    ItemChanged,
    DeveloperItem,
    FieldLocked,
    HumanOwned,
    ValueRequired,
    ItemComplete,
    ChecklistExists,
    NotAgentCompletable,
}

impl ErrorCode {
    /// Every error code, for exhaustive checks.
    pub const ALL: [Self; 13] = [
        Self::InvalidInput,
        Self::TooLarge,
        Self::UnknownItem,
        Self::ItemRemoved,
        Self::Conflict,
        Self::ItemChanged,
        Self::DeveloperItem,
        Self::FieldLocked,
        Self::HumanOwned,
        Self::ValueRequired,
        Self::ItemComplete,
        Self::ChecklistExists,
        Self::NotAgentCompletable,
    ];

    /// The wire name of the code.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::TooLarge => "too_large",
            Self::UnknownItem => "unknown_item",
            Self::ItemRemoved => "item_removed",
            Self::Conflict => "conflict",
            Self::ItemChanged => "item_changed",
            Self::DeveloperItem => "developer_item",
            Self::FieldLocked => "field_locked",
            Self::HumanOwned => "human_owned",
            Self::ValueRequired => "value_required",
            Self::ItemComplete => "item_complete",
            Self::ChecklistExists => "checklist_exists",
            Self::NotAgentCompletable => "not_agent_completable",
        }
    }
}

/// `field` names the offending field for `too_large` and `invalid_input`; `item_ids` names the
/// items behind an item-level error (`conflict` lists every conflicting one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecklistError {
    pub code: ErrorCode,
    pub field: Option<&'static str>,
    pub item_ids: Vec<String>,
}

impl ChecklistError {
    /// An error with no extra detail.
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            field: None,
            item_ids: Vec::new(),
        }
    }

    /// An error naming the offending field.
    pub fn field(code: ErrorCode, field: &'static str) -> Self {
        Self {
            field: Some(field),
            ..Self::new(code)
        }
    }

    /// An error naming one item.
    pub fn item(code: ErrorCode, id: &str) -> Self {
        Self::items(code, vec![id.to_string()])
    }

    /// An error naming several items.
    pub fn items(code: ErrorCode, item_ids: Vec<String>) -> Self {
        Self {
            item_ids,
            ..Self::new(code)
        }
    }
}

impl From<FieldError> for ChecklistError {
    fn from(e: FieldError) -> Self {
        let code = match e.kind {
            FieldErrorKind::TooLarge => ErrorCode::TooLarge,
            FieldErrorKind::InvalidInput => ErrorCode::InvalidInput,
        };
        Self::field(code, e.field.name())
    }
}

/// An item to add, as supplied by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewItem {
    pub text: String,
    pub owner: Option<ItemOwner>,
    pub requires_value: Option<bool>,
    pub agent_completable: Option<bool>,
    pub group: Option<String>,
}

/// `Edit` carries the fixed fields so the engines can answer `field_locked` for them instead of
/// the decoder rejecting them as unknown keys.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
/// One decoded edit operation on a checklist.
pub enum ChecklistOp {
    Add {
        after: Option<String>,
        item: NewItem,
    },
    Edit {
        id: String,
        text: Option<String>,
        group: Option<String>,
        owner: Option<ItemOwner>,
        requires_value: Option<bool>,
        agent_completable: Option<bool>,
    },
    Move {
        id: String,
        after: Option<String>,
    },
    Remove {
        id: String,
    },
    SetStatus {
        id: String,
        status: ItemStatus,
    },
    SetValue {
        id: String,
        value: String,
    },
}

impl ChecklistOp {
    /// The existing item the op acts on; `add` acts on none.
    pub fn target_id(&self) -> Option<&str> {
        match self {
            Self::Add { .. } => None,
            Self::Edit { id, .. }
            | Self::Move { id, .. }
            | Self::Remove { id }
            | Self::SetStatus { id, .. }
            | Self::SetValue { id, .. } => Some(id),
        }
    }
}

/// Decodes a JSON op, rejecting unknown kinds and owners.
pub fn decode_op(value: &Value) -> Result<ChecklistOp, ChecklistError> {
    ChecklistOp::deserialize(value)
        .map_err(|_| ChecklistError::field(ErrorCode::InvalidInput, "op"))
}

/// Rejects an empty or oversize op batch.
pub fn check_op_count(count: usize) -> Result<(), ChecklistError> {
    if count == 0 {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "ops"));
    }
    if count > MAX_OPS {
        return Err(ChecklistError::field(ErrorCode::TooLarge, "ops"));
    }
    Ok(())
}

/// The count is checked before any op is decoded, so an oversized call is `too_large` even when
/// its tail would not decode.
pub fn decode_ops(values: &[Value]) -> Result<Vec<ChecklistOp>, ChecklistError> {
    check_op_count(values.len())?;
    values.iter().map(decode_op).collect()
}

/// The result of an accepted call: the new checklist and the ids it assigned, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub checklist: Checklist,
    pub added_ids: Vec<String>,
}

/// One bump per accepted call: every op of an update shares the revision.
pub fn bump_rev(list: &mut Checklist) -> u64 {
    list.rev += 1;
    list.rev
}

/// Marks an item as changed at a revision by the given actor.
pub fn stamp(item: &mut ChecklistItem, rev: u64, actor: Actor) {
    item.rev = rev;
    item.updated_by = actor;
}

/// Reopening is one gesture, not a free status pick: the item returns to where it was, so the
/// requested non-complete status is not used. `previous_status` is kept on every other move.
pub fn set_status(item: &mut ChecklistItem, status: ItemStatus, rev: u64, actor: Actor) {
    let was = item.status;
    if status == ItemStatus::Complete {
        if was != ItemStatus::Complete {
            item.previous_status = Some(was);
        }
        item.status = ItemStatus::Complete;
        item.completed_by = Some(actor);
    } else if was == ItemStatus::Complete {
        item.status = item.previous_status.take().unwrap_or(ItemStatus::Upcoming);
        item.completed_by = None;
    } else {
        item.status = status;
    }
    item.status_rev = rev;
    stamp(item, rev, actor);
}

/// `unknown_item` for an id that never existed, `item_removed` for a retired one. The counter
/// decides, because the removed list is capped and pruned.
pub fn find(list: &Checklist, id: &str) -> Result<usize, ChecklistError> {
    if let Some(i) = list.items.iter().position(|item| item.id == id) {
        return Ok(i);
    }
    let retired = id
        .strip_prefix('i')
        .and_then(|n| n.parse::<u64>().ok())
        .is_some_and(|n| n >= 1 && n < list.next_item_seq && format!("i{n}") == id);
    let code = if retired {
        ErrorCode::ItemRemoved
    } else {
        ErrorCode::UnknownItem
    };
    Err(ChecklistError::item(code, id))
}

fn checked_text(text: &str) -> Result<(), ChecklistError> {
    validate(Field::Text, text)?;
    if text.is_empty() {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "text"));
    }
    Ok(())
}

/// `actor` picks the default owner: what the agent adds is its own work, what the developer adds
/// is theirs.
pub fn add_item(
    list: &mut Checklist,
    after: Option<&str>,
    new: &NewItem,
    rev: u64,
    actor: Actor,
) -> Result<String, ChecklistError> {
    if list.items.len() >= MAX_ITEMS {
        return Err(ChecklistError::field(ErrorCode::TooLarge, "items"));
    }
    checked_text(&new.text)?;
    if let Some(group) = &new.group {
        validate(Field::Group, group)?;
    }
    let at = match after {
        Some(anchor) => find(list, anchor)? + 1,
        None => list.items.len(),
    };
    let id = take_item_id(list);
    let owner = new.owner.unwrap_or(match actor {
        Actor::Agent => ItemOwner::Agent,
        Actor::Developer => ItemOwner::Human,
    });
    list.items.insert(
        at,
        ChecklistItem {
            id: id.clone(),
            text: new.text.clone(),
            status: ItemStatus::Upcoming,
            previous_status: None,
            owner,
            requires_value: new.requires_value.unwrap_or(false),
            value: None,
            value_by: None,
            agent_completable: new.agent_completable.unwrap_or(true),
            group: new.group.clone(),
            rev,
            status_rev: rev,
            created_by: actor,
            updated_by: actor,
            completed_by: None,
            edited_by_developer: false,
            last_developer_ops: Vec::new(),
        },
    );
    Ok(id)
}

/// A key present in an `edit` is a change attempt even when it repeats the stored value, so the
/// caller cannot probe which values are stored.
pub fn reject_locked(op: &ChecklistOp) -> Result<(), ChecklistError> {
    let ChecklistOp::Edit {
        owner,
        requires_value,
        agent_completable,
        ..
    } = op
    else {
        return Ok(());
    };
    let locked = if owner.is_some() {
        "owner"
    } else if requires_value.is_some() {
        "requiresValue"
    } else if agent_completable.is_some() {
        "agentCompletable"
    } else {
        return Ok(());
    };
    Err(ChecklistError::field(ErrorCode::FieldLocked, locked))
}

/// Returns the names of the fields the edit changed, for the developer's change record.
pub fn edit_item(
    item: &mut ChecklistItem,
    text: Option<&str>,
    group: Option<&str>,
    rev: u64,
    actor: Actor,
) -> Result<Vec<String>, ChecklistError> {
    if text.is_none() && group.is_none() {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "edit"));
    }
    if let Some(text) = text {
        checked_text(text)?;
    }
    if let Some(group) = group {
        validate(Field::Group, group)?;
    }
    let mut fields = Vec::new();
    if let Some(text) = text {
        item.text = text.to_string();
        fields.push("text".to_string());
    }
    if let Some(group) = group {
        item.group = Some(group.to_string());
        fields.push("group".to_string());
    }
    stamp(item, rev, actor);
    Ok(fields)
}

/// With no `after` the item goes to the end, as `add` does. An anchor that is the item itself has
/// no meaning.
pub fn move_item(
    list: &mut Checklist,
    id: &str,
    after: Option<&str>,
    rev: u64,
    actor: Actor,
) -> Result<(), ChecklistError> {
    let from = find(list, id)?;
    let anchor = after.map(|a| find(list, a)).transpose()?;
    if anchor == Some(from) {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "after"));
    }
    let mut item = list.items.remove(from);
    stamp(&mut item, rev, actor);
    let at = match anchor {
        Some(a) if a > from => a,
        Some(a) => a + 1,
        None => list.items.len(),
    };
    list.items.insert(at, item);
    Ok(())
}

/// The id is retired by the counter; this entry only feeds `userChanges`, so the oldest one is
/// dropped at the cap.
pub fn remove_item(
    list: &mut Checklist,
    id: &str,
    rev: u64,
    actor: Actor,
) -> Result<(), ChecklistError> {
    let at = find(list, id)?;
    list.items.remove(at);
    list.removed.push(RemovedEntry {
        id: id.to_string(),
        rev,
        by: actor,
    });
    if list.removed.len() > MAX_REMOVED {
        list.removed.remove(0);
    }
    Ok(())
}

/// An empty value clears it.
pub fn set_value(
    item: &mut ChecklistItem,
    value: &str,
    rev: u64,
    actor: Actor,
) -> Result<(), ChecklistError> {
    validate(Field::Value, value)?;
    if value.is_empty() {
        item.value = None;
        item.value_by = None;
    } else {
        item.value = Some(value.to_string());
        item.value_by = Some(actor);
    }
    stamp(item, rev, actor);
    Ok(())
}

#[cfg(test)]
#[path = "ops.test.rs"]
mod tests;
