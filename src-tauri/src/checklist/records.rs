// Send records: which "complete this step" / ask / value turns went out for which item revision, so
// a retried send is recognised. Only a hash of the turn text is kept (design "Envelope").

use sha2::{Digest, Sha256};

use super::model::{
    Actor, Checklist, ChecklistFile, ItemStatus, OpKind, PendingComplete, SendAction, SendRecord,
    MAX_SEND_RECORDS,
};
use super::ops::{bump_rev, stamp};

/// Hashes send text so a record never stores the text itself.
pub fn text_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Newest last; the oldest records are evicted once the cap is exceeded.
pub fn add_send_record(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    rev: u64,
    action: SendAction,
    text: &str,
) {
    file.send_records.push(SendRecord {
        checklist_id: checklist_id.to_string(),
        item_id: item_id.to_string(),
        rev,
        action,
        text_hash: text_hash(text),
    });
    let excess = file.send_records.len().saturating_sub(MAX_SEND_RECORDS);
    file.send_records.drain(..excess);
}

/// Whether a matching send record already exists.
pub fn has_send_record(
    file: &ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    rev: u64,
    action: SendAction,
    text: &str,
) -> bool {
    is_recorded(&file.send_records, checklist_id, item_id, rev, action, text)
}

/// `has_send_record` over a snapshot of the records, so a reader need not hold the file.
pub fn is_recorded(
    records: &[SendRecord],
    checklist_id: &str,
    item_id: &str,
    rev: u64,
    action: SendAction,
    text: &str,
) -> bool {
    let hash = text_hash(text);
    records.iter().any(|r| {
        r.checklist_id == checklist_id
            && r.item_id == item_id
            && r.rev == rev
            && r.action == action
            && r.text_hash == hash
    })
}

/// Drops the newest matching send record, for a send that was refused. Returns whether one went.
pub fn remove_send_record(
    file: &mut ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    rev: u64,
    action: SendAction,
    text: &str,
) -> bool {
    let hash = text_hash(text);
    let Some(at) = file.send_records.iter().rposition(|r| {
        r.checklist_id == checklist_id
            && r.item_id == item_id
            && r.rev == rev
            && r.action == action
            && r.text_hash == hash
    }) else {
        return false;
    };
    file.send_records.remove(at);
    true
}

fn has_complete_record(file: &ChecklistFile, entry: &PendingComplete) -> bool {
    file.send_records.iter().any(|r| {
        r.checklist_id == entry.checklist_id
            && r.item_id == entry.item_id
            && r.rev == entry.turn_marker
            && r.action == SendAction::Complete
    })
}

/// Under the Session lock, before the turn goes out: the item becomes `in_progress`, an entry and
/// the send record are added. `build` receives the new `rev` and returns the turn text, so the
/// envelope carries the `rev` it is recorded under and the record hashes the text actually sent.
/// Returns the `turnMarker` and that text, or `None` when there is nothing to start (the caller
/// checks owner and value rules).
pub fn accept_complete(
    file: &mut ChecklistFile,
    item_id: &str,
    build: impl FnOnce(u64) -> String,
) -> Option<(u64, String)> {
    let list = file.active.as_mut()?;
    let idx = list.items.iter().position(|i| i.id == item_id)?;
    let checklist_id = list.id.clone();
    let busy = file
        .pending_complete
        .iter()
        .any(|e| e.checklist_id == checklist_id && e.item_id == item_id);
    if busy || list.items[idx].status == ItemStatus::Complete {
        return None;
    }
    let rev = bump_rev(list);
    let text = build(rev);
    let item = &mut list.items[idx];
    item.previous_status = Some(item.status);
    item.status = ItemStatus::InProgress;
    item.status_rev = rev;
    stamp(item, rev, Actor::Developer);
    file.pending_complete.push(PendingComplete {
        checklist_id: checklist_id.clone(),
        item_id: item_id.to_string(),
        turn_marker: rev,
        started: false,
    });
    add_send_record(
        file,
        &checklist_id,
        item_id,
        rev,
        SendAction::Complete,
        &text,
    );
    Some((rev, text))
}

fn restore_previous(list: &mut Checklist, idx: usize) {
    let rev = bump_rev(list);
    let item = &mut list.items[idx];
    item.status = item.previous_status.take().unwrap_or(ItemStatus::Upcoming);
    item.status_rev = rev;
    item.rev = rev;
}

/// The send was refused: undo `accept_complete` whatever else changed, since nothing else could
/// have run under the lock. Returns whether there was an entry.
pub fn refuse_complete(file: &mut ChecklistFile, item_id: &str) -> bool {
    let Some(pos) = file.pending_complete.iter().position(|e| {
        e.item_id == item_id && file.active.as_ref().is_some_and(|l| l.id == e.checklist_id)
    }) else {
        return false;
    };
    let entry = file.pending_complete.remove(pos);
    if let Some(list) = file.active.as_mut() {
        if let Some(idx) = list.items.iter().position(|i| i.id == item_id) {
            restore_previous(list, idx);
        }
    }
    if let Some(at) = file.send_records.iter().rposition(|r| {
        r.checklist_id == entry.checklist_id
            && r.item_id == entry.item_id
            && r.rev == entry.turn_marker
            && r.action == SendAction::Complete
    }) {
        file.send_records.remove(at);
    }
    true
}

/// Drops, with no revert, an entry whose item has since been re-statused by anyone, removed,
/// edited by the developer, or archived by a replace. A value-only change leaves it alone.
/// Call it after every accepted op. Returns whether any entry went.
pub fn clear_resolved(file: &mut ChecklistFile) -> bool {
    let before = file.pending_complete.len();
    let active = &file.active;
    file.pending_complete.retain(|e| {
        let Some(list) = active.as_ref().filter(|l| l.id == e.checklist_id) else {
            return false;
        };
        list.items.iter().any(|item| {
            item.id == e.item_id
                && item.status == ItemStatus::InProgress
                && item.status_rev == e.turn_marker
                && !item
                    .last_developer_ops
                    .iter()
                    .any(|o| o.kind == OpKind::Edit && o.rev > e.turn_marker)
        })
    });
    file.pending_complete.len() != before
}

/// The entry's own turn reached the transcript. Only an unstarted entry of that exact `rev`
/// starts, so a queued turn never starts early.
pub fn start_entry(file: &mut ChecklistFile, checklist_id: &str, item_id: &str, rev: u64) -> bool {
    let Some(entry) = file.pending_complete.iter_mut().find(|e| {
        e.checklist_id == checklist_id && e.item_id == item_id && e.turn_marker == rev && !e.started
    }) else {
        return false;
    };
    entry.started = true;
    true
}

/// Removes each selected entry and restores its previous status only if the item is still
/// `in_progress` with the `statusRev` the entry set; otherwise someone moved it and it stays.
fn settle_where(
    file: &mut ChecklistFile,
    select: impl Fn(&ChecklistFile, &PendingComplete) -> bool,
) -> bool {
    let all = std::mem::take(&mut file.pending_complete);
    let (taken, kept): (Vec<_>, Vec<_>) = all.into_iter().partition(|e| select(file, e));
    file.pending_complete = kept;
    let mut changed = !taken.is_empty();
    for entry in taken {
        let Some(list) = file.active.as_mut().filter(|l| l.id == entry.checklist_id) else {
            continue;
        };
        let untouched = list.items.iter().position(|i| {
            i.id == entry.item_id
                && i.status == ItemStatus::InProgress
                && i.status_rev == entry.turn_marker
        });
        if let Some(idx) = untouched {
            restore_previous(list, idx);
            changed = true;
        }
    }
    changed
}

/// The turn settled: started entries, and entries whose send record was evicted and so can never
/// start. Any other unstarted entry waits for its own turn.
pub fn settle_started(file: &mut ChecklistFile) -> bool {
    settle_where(file, |f, e| e.started || !has_complete_record(f, e))
}

/// `stop` withdraws the queued turns, so every unstarted entry is settled.
pub fn settle_unstarted(file: &mut ChecklistFile) -> bool {
    settle_where(file, |_, e| !e.started)
}

/// Relaunch, and a load with no live turn: every entry is stale and gets the same rule.
pub fn settle_all(file: &mut ChecklistFile) -> bool {
    settle_where(file, |_, _| true)
}

#[cfg(test)]
#[path = "records.test.rs"]
mod tests;
