// Labels a user turn the panel sent as a checklist item, so the chat shows its source line and the
// body instead of the raw envelope. Pure: the caller supplies the send records.

use std::sync::Arc;

use crate::agent_tools::checklist_envelope::parse;
use crate::checklist::model::ChecklistFile;
use crate::checklist::records::has_send_record;
use crate::omp::transcript::{MessageSource, TranscriptItem};

/// The source and unescaped body of `text` when it is exactly one envelope that a send record
/// vouches for on all five fields; otherwise `None`, and the turn stays plain text.
pub fn match_checklist_item(text: &str, file: &ChecklistFile) -> Option<(MessageSource, String)> {
    let envelope = parse(text)?;
    // The hash covers the whole delivered turn, so it is taken from the original text.
    if !has_send_record(
        file,
        &envelope.checklist_id,
        &envelope.item_id,
        envelope.rev,
        envelope.action,
        text,
    ) {
        return None;
    }
    let source = MessageSource::ChecklistItem {
        checklist_id: envelope.checklist_id,
        item_id: envelope.item_id,
        action: envelope.action,
    };
    Some((source, envelope.body))
}

/// Relabelled copies of the user items that match, with their index. An item that already has a
/// source (a handoff note, another Session's message) is never reread, so a forged envelope
/// there stays text and a second pass over a labelled list changes nothing.
pub fn apply_checklist_sources(
    items: &[Arc<TranscriptItem>],
    file: &ChecklistFile,
) -> Vec<(usize, TranscriptItem)> {
    let mut changes = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let TranscriptItem::User {
            text, source: None, ..
        } = item.as_ref()
        else {
            continue;
        };
        let Some((matched, body)) = match_checklist_item(text, file) else {
            continue;
        };
        let mut labelled = item.as_ref().clone();
        if let TranscriptItem::User { text, source, .. } = &mut labelled {
            *text = body;
            *source = Some(matched);
        }
        changes.push((index, labelled));
    }
    changes
}

#[cfg(test)]
#[path = "checklist_source.test.rs"]
mod tests;
