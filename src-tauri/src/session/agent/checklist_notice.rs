// The checklist's line for the agent's next user prompt, read from the one shared store.

use super::SessionAgent;
use crate::checklist::hint::{checklist_hint, conversation_line};
use crate::checklist::store::LiveSession;

impl SessionAgent {
    /// The Conversation line while the agent's Conversation has not met the checklist, else the
    /// hint when the developer changed it; `None` for a Session with no active checklist.
    pub(super) async fn checklist_line(&self, conversation_due: bool) -> Option<String> {
        let manager = self.tool_manager()?;
        let live = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .is_some();
        let live = LiveSession::check(
            &self.session_id,
            |_| live,
            crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting,
        )
        .ok()?;
        manager
            .checklists()
            .read(&live, |file| {
                if conversation_due {
                    conversation_line(file)
                } else {
                    checklist_hint(file)
                }
            })
            .await
            .ok()
            .flatten()
    }
}

#[cfg(test)]
#[path = "checklist_notice.test.rs"]
mod tests;
