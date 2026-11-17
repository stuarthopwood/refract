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
    let mut marked = item.as_ref().clone();
    match &mut marked {
        TranscriptItem::User { source, .. } if source.is_none() => {
            *source = Some(MessageSource::Handoff);
        }
        _ => return None,
    }
    Some((index, marked))
}

#[cfg(test)]
#[path = "handoff_note.test.rs"]
mod tests;
