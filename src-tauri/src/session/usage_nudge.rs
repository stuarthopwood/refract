// Nudges the Usage worker on `message_end`. The path comes from the registry, never the frame.

use std::path::Path;

use serde_json::Value;

use super::agent::SessionAgent;

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, _frame: &Value) {
    if frame_type != "message_end" {
        return;
    }
    if let Some(path) = agent.current_conversation_path().await {
        crate::ipc::usage::nudge(Path::new(&path));
    }
}
