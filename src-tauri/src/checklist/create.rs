// Creating a checklist, archiving the one it replaces, and the `requestId` retry guard (spec 138
// FR-008, FR-014). Pure: the result is a whole new file value the store swaps in, so a refused or
// failed call leaves the stored checklist as it was.

use super::ids::take_checklist_id;
use super::model::{
    Actor, Checklist, ChecklistFile, ItemStatus, RecentRequest, MAX_ARCHIVED, MAX_ITEMS,
    MAX_RECENT_REQUESTS,
};
use super::ops::{add_item, ChecklistError, ChecklistOp, ErrorCode, NewItem};
use super::validate::{validate, Field};

pub struct CreateArgs<'a> {
    pub request_id: Option<&'a str>,
    pub title: &'a str,
    pub items: &'a [NewItem],
    pub replace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Created {
        file: Box<ChecklistFile>,
        ids: Vec<String>,
    },
    /// The request was already applied; `ids` are the ones it assigned.
    Duplicate { ids: Vec<String> },
    /// `replace` would discard developer input. The handler raises the card and calls again with
    /// `approved` set; a denied card never calls again.
    NeedsCard { developer_items: usize },
}

pub fn check_request_id(request_id: Option<&str>, required: bool) -> Result<(), ChecklistError> {
    let invalid = || ChecklistError::field(ErrorCode::InvalidInput, "requestId");
    match request_id {
        None if required => Err(invalid()),
        None => Ok(()),
        Some(id) => {
            validate(Field::RequestId, id)?;
            if id.is_empty() {
                return Err(invalid());
            }
            Ok(())
        }
    }
}

/// These ops touch no existing item's `rev`, so only a `requestId` can stop a retry applying twice.
pub fn is_structural(ops: &[ChecklistOp]) -> bool {
    ops.iter().any(|op| {
        matches!(
            op,
            ChecklistOp::Add { .. } | ChecklistOp::Move { .. } | ChecklistOp::Remove { .. }
        )
    })
}

pub fn recorded_ids<'a>(list: &'a Checklist, request_id: &str) -> Option<&'a [String]> {
    list.recent_requests
        .iter()
        .find(|r| r.request_id == request_id)
        .map(|r| r.added_ids.as_slice())
}

pub fn record_request(list: &mut Checklist, request_id: &str, rev: u64, added_ids: Vec<String>) {
    list.recent_requests.push(RecentRequest {
        request_id: request_id.to_string(),
        rev,
        added_ids,
    });
    if list.recent_requests.len() > MAX_RECENT_REQUESTS {
        list.recent_requests.remove(0);
    }
}

fn unfinished(list: &Checklist) -> bool {
    list.items.iter().any(|i| i.status != ItemStatus::Complete)
}

/// Unfinished items the developer wrote or filled in: what a `replace` would discard.
fn developer_input(list: &Checklist) -> usize {
    list.items
        .iter()
        .filter(|i| i.status != ItemStatus::Complete)
        .filter(|i| i.created_by == Actor::Developer || i.value_by == Some(Actor::Developer))
        .count()
}

/// Values are dropped so an archive never keeps developer-entered data; the newest checklists stay.
fn archive(file: &mut ChecklistFile, mut list: Checklist) {
    for item in &mut list.items {
        item.value = None;
        item.value_by = None;
    }
    file.archived.push(list);
    if file.archived.len() > MAX_ARCHIVED {
        file.archived.remove(0);
    }
}

pub fn create(
    file: &ChecklistFile,
    args: &CreateArgs,
    approved: bool,
    now: &str,
) -> Result<CreateOutcome, ChecklistError> {
    check_request_id(args.request_id, true)?;
    let request_id = args.request_id.unwrap_or_default();
    // Before any other check: a retry of an applied call finds an active, unfinished checklist
    // and would otherwise fail with `checklist_exists`.
    if let Some(ids) = file
        .active
        .as_ref()
        .and_then(|active| recorded_ids(active, request_id))
    {
        return Ok(CreateOutcome::Duplicate { ids: ids.to_vec() });
    }

    validate(Field::Title, args.title)?;
    if args.title.is_empty() {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "title"));
    }
    if args.items.is_empty() {
        return Err(ChecklistError::field(ErrorCode::InvalidInput, "items"));
    }
    if args.items.len() > MAX_ITEMS {
        return Err(ChecklistError::field(ErrorCode::TooLarge, "items"));
    }

    let mut next = file.clone();
    let mut list = Checklist::empty(
        take_checklist_id(&mut next),
        args.title.to_string(),
        now.to_string(),
    );
    list.rev = 1;
    let ids = args
        .items
        .iter()
        .map(|new| add_item(&mut list, None, new, 1, Actor::Agent))
        .collect::<Result<Vec<_>, _>>()?;
    record_request(&mut list, request_id, 1, ids.clone());

    if let Some(active) = next.active.take() {
        if unfinished(&active) {
            if !args.replace {
                return Err(ChecklistError::new(ErrorCode::ChecklistExists));
            }
            let developer_items = developer_input(&active);
            if developer_items > 0 && !approved {
                return Ok(CreateOutcome::NeedsCard { developer_items });
            }
        }
        archive(&mut next, active);
    }
    next.active = Some(list);
    Ok(CreateOutcome::Created {
        file: Box::new(next),
        ids,
    })
}

#[cfg(test)]
#[path = "create.test.rs"]
mod tests;
