// Send records: which "complete this step" / ask / value turns went out for which item revision, so
// a retried send is recognised. Only a hash of the turn text is kept (design "Envelope").

use sha2::{Digest, Sha256};

use super::model::{ChecklistFile, SendAction, SendRecord, MAX_SEND_RECORDS};

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

pub fn has_send_record(
    file: &ChecklistFile,
    checklist_id: &str,
    item_id: &str,
    rev: u64,
    action: SendAction,
    text: &str,
) -> bool {
    let hash = text_hash(text);
    file.send_records.iter().any(|r| {
        r.checklist_id == checklist_id
            && r.item_id == item_id
            && r.rev == rev
            && r.action == action
            && r.text_hash == hash
    })
}

#[cfg(test)]
#[path = "records.test.rs"]
mod tests;
