// Handoff state of a Session's agent (#1861): whether the current Conversation opens with a note.

use super::AgentState;
use crate::session::handoff_note::marked_first_user;

#[derive(Default)]
pub(super) struct State {
    /// The current Conversation's first user message is a handoff note.
    pub note_live: bool,
}

/// Labels the first user item when the flag is set; `message_start`/`message_end` rebuild that
/// item without the label, so this runs after every frame.
pub(super) fn mark_note(state: &mut AgentState) {
    if !state.handoff.note_live {
        return;
    }
    if let Some((_, marked)) = marked_first_user(state.transcript.items()) {
        state.transcript.upsert_item(marked);
    }
}

/// Whether the Conversation file is listed as opened by a handoff note.
pub(super) async fn is_note_file(file: Option<&str>) -> bool {
    match file {
        Some(file) => crate::store::handoff_notes::contains(file).await,
        None => false,
    }
}

#[cfg(test)]
#[path = "queued_handoff.test.rs"]
mod tests;
