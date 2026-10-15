// Two tiny public status accessors, split out of `mod.rs` (issue #806, 600-line cap: the #572
// ask-dialog `ask_dialog_enabled` field addition pushed it one line over). No behaviour change --
// moved verbatim. See `mod.rs`'s own header for this module's place in the `agent/` split and the
// lane extension contract.

use serde_json::Value;

use super::{SessionAgent, SessionStatus};

impl SessionAgent {
    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn available_commands(&self) -> Vec<Value> {
        self.state.lock().await.commands.clone()
    }
}
