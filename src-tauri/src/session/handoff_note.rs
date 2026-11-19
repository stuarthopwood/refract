// Finds the message a handoff note labels: the Conversation's first user turn.

use std::sync::Arc;

use crate::omp::transcript::{MessageSource, TranscriptItem};

/// The first user item, cloned with the handoff source set. `None` when there is no user item or
/// the first one already has a source (another Session's message, or already marked), so a second
/// call on a marked list is a no-op and never labels a later turn.
pub(super) fn marked_first_user(items: &[Arc<TranscriptItem>]) -> Option<(usize, TranscriptItem)> {
    let (index, item) = items
        .iter()
        .enumerate()
        .find(|(_, item)| matches!(item.as_ref(), TranscriptItem::User { .. }))?;
    // Checked on the borrowed item: this runs after every streamed frame, and an unmarkable
    // first message must not be cloned each time.
    if !matches!(item.as_ref(), TranscriptItem::User { source: None, .. }) {
        return None;
    }
    let mut marked = item.as_ref().clone();
    if let TranscriptItem::User { source, .. } = &mut marked {
        *source = Some(MessageSource::Handoff);
    }
    Some((index, marked))
}

#[cfg(test)]
#[path = "handoff_note.test.rs"]
mod tests;
