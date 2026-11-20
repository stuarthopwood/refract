// Result and error shaping for `refract_checklist`. A result that reaches
// `MAX_RESULT_BYTES` is dropped whole by the router, `userChanges` included, so every field is
// capped and every list stops at a byte budget with an overflow flag.

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::changes::{ChangeSet, UserChange};
use super::model::{Checklist, ChecklistItem};
use super::ops::{ChecklistError, ErrorCode};

/// Total byte budget of a tool result.
pub const RESULT_BUDGET_BYTES: usize = 7168;
/// The `items` list's share of `RESULT_BUDGET_BYTES` after the worst-case header, ids and changes.
pub const ITEMS_BUDGET_BYTES: usize = 3948;
/// Bytes of item text shown before it is cut.
pub const TEXT_PREVIEW_BYTES: usize = 60;
/// Byte cap for an error message.
pub const MAX_MESSAGE_BYTES: usize = 160;

fn tag<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn preview(text: &str) -> (&str, bool) {
    if text.len() <= TEXT_PREVIEW_BYTES {
        return (text, false);
    }
    let mut end = TEXT_PREVIEW_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// A value is never inlined, only its presence and size; `get { itemId }` reads it whole.
pub fn compact_item(item: &ChecklistItem) -> Value {
    let (text, truncated) = preview(&item.text);
    let mut out = Map::new();
    out.insert("id".into(), json!(item.id));
    out.insert("status".into(), tag(&item.status));
    out.insert("rev".into(), json!(item.rev));
    out.insert("text".into(), json!(text));
    if truncated {
        out.insert("textTruncated".into(), json!(true));
    }
    out.insert("owner".into(), tag(&item.owner));
    out.insert("requiresValue".into(), json!(item.requires_value));
    out.insert("agentCompletable".into(), json!(item.agent_completable));
    out.insert("hasValue".into(), json!(item.value.is_some()));
    if let Some(value) = &item.value {
        out.insert("valueBytes".into(), json!(value.len()));
    }
    out.insert("updatedBy".into(), tag(&item.updated_by));
    out.insert("editedByDeveloper".into(), json!(item.edited_by_developer));
    Value::Object(out)
}

/// The stored item for `get { full }` and `get { itemId }`, less the change record the agent
/// reads through `userChanges` instead.
pub fn full_item(item: &ChecklistItem) -> Value {
    let mut value = tag(item);
    if let Some(map) = value.as_object_mut() {
        map.remove("lastDeveloperOps");
        map.remove("statusRev");
    }
    value
}

/// Fills by bytes, not count, and always returns the first item: one full item fits the budget.
pub fn items_page(items: &[&ChecklistItem], full: bool) -> (Vec<Value>, bool) {
    let mut page = Vec::new();
    let mut used = 0;
    for item in items {
        let value = if full {
            full_item(item)
        } else {
            compact_item(item)
        };
        let size = value.to_string().len() + usize::from(!page.is_empty());
        if !page.is_empty() && used + size > ITEMS_BUDGET_BYTES {
            return (page, true);
        }
        used += size;
        page.push(value);
    }
    (page, false)
}

fn change_json(change: &UserChange) -> Value {
    let mut out = Map::new();
    out.insert("rev".into(), json!(change.rev));
    out.insert("itemId".into(), json!(change.item_id));
    out.insert("op".into(), tag(&change.op));
    out.insert("by".into(), json!("developer"));
    if let Some(status) = change.status {
        out.insert("status".into(), tag(&status));
    }
    if let Some(bytes) = change.value_bytes {
        out.insert("valueBytes".into(), json!(bytes));
    }
    if !change.fields.is_empty() {
        out.insert("fields".into(), json!(change.fields));
    }
    Value::Object(out)
}

/// Everything build_result needs to render a result.
pub struct ResultInput<'a> {
    pub list: &'a Checklist,
    pub duplicate: bool,
    /// `("ids", ..)` for `create`, `("addedIds", ..)` for `update`: every id the call assigned.
    pub assigned: Option<(&'static str, &'a [String])>,
    pub items: Vec<&'a ChecklistItem>,
    pub full: bool,
    pub changes: &'a ChangeSet,
}

/// Renders a bounded result for the agent from the checklist and changes.
pub fn build_result(input: &ResultInput) -> Value {
    let list = input.list;
    let (items, more_items) = items_page(&input.items, input.full);
    let mut out = Map::new();
    out.insert("checklistId".into(), json!(list.id));
    out.insert("rev".into(), json!(list.rev));
    out.insert("seenRev".into(), json!(input.changes.seen_rev));
    out.insert("title".into(), json!(list.title));
    out.insert("state".into(), json!("active"));
    out.insert("itemCount".into(), json!(list.items.len()));
    out.insert("duplicate".into(), json!(input.duplicate));
    if let Some((key, ids)) = input.assigned {
        out.insert(key.into(), json!(ids));
    }
    out.insert("items".into(), Value::Array(items));
    out.insert("moreItems".into(), json!(more_items));
    out.insert(
        "userChanges".into(),
        Value::Array(input.changes.changes.iter().map(change_json).collect()),
    );
    out.insert("moreChanges".into(), json!(input.changes.more));
    Value::Object(out)
}

/// `get` with no active checklist.
pub fn none_result() -> Value {
    json!({ "state": "none" })
}

/// Every message names the next step, and stays under `MAX_MESSAGE_BYTES` for the header budget.
pub fn message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::InvalidInput => "A field is missing or not allowed. Fix the named field and call again.",
        ErrorCode::TooLarge => "A field or list is over its size limit. Shorten the named field or split the call.",
        ErrorCode::UnknownItem => "No such item id exists in this checklist. Use an id from the items listed here.",
        ErrorCode::ItemRemoved => "That item was removed and its id is retired. Use an id from the items listed here.",
        ErrorCode::Conflict => "Items changed after your baseRev. Nothing was applied; re-plan from the items listed here.",
        ErrorCode::ItemChanged => "The agent changed this item after the developer's baseRev. Nothing was applied.",
        ErrorCode::DeveloperItem => "The developer owns this item or its value. You cannot edit, remove or overwrite it.",
        ErrorCode::FieldLocked => "owner, requiresValue and agentCompletable are fixed at creation. Remove and add the item again.",
        ErrorCode::HumanOwned => "This item belongs to the developer. Only they can complete it.",
        ErrorCode::ValueRequired => "This item needs a value set by the developer before it can be completed.",
        ErrorCode::ItemComplete => "A completed item is frozen for the agent. Only the developer can reopen it.",
        ErrorCode::ChecklistExists => "An unfinished checklist is active. Pass replace: true to archive it and start a new one.",
        ErrorCode::NotAgentCompletable => "The agent cannot be asked to complete this item: it is human-owned, not agent-completable, complete or already queued.",
    }
}

/// Lists the items the error is about when any still exist, else the first page of the checklist,
/// so the agent can re-plan without another `get`.
pub fn error_payload(err: &ChecklistError, list: Option<&Checklist>) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), json!(err.code.as_str()));
    error.insert("message".into(), json!(message(err.code)));
    if let Some(field) = err.field {
        error.insert("field".into(), json!(field));
    }
    let mut out = Map::new();
    out.insert("error".into(), Value::Object(error));
    if let Some(list) = list {
        out.insert("checklistId".into(), json!(list.id));
        out.insert("rev".into(), json!(list.rev));
        let named: Vec<&ChecklistItem> = err
            .item_ids
            .iter()
            .filter_map(|id| list.items.iter().find(|i| &i.id == id))
            .collect();
        let shown = if named.is_empty() {
            list.items.iter().collect()
        } else {
            named
        };
        let (items, more) = items_page(&shown, false);
        out.insert("items".into(), Value::Array(items));
        out.insert("moreItems".into(), json!(more));
    }
    Value::Object(out)
}

#[cfg(test)]
#[path = "result.test.rs"]
mod tests;
