// Public status accessors, split out of `mod.rs` to stay under the 600-line cap.

use serde_json::{json, Value};

use super::{AgentState, SessionAgent, SessionStatus};

impl SessionAgent {
    pub(super) fn status_event_locked(&self, state: &AgentState) -> Value {
        let mut payload = json!({
            "sessionId": self.session_id,
            "status": state.status,
            "unread": state.unread,
            "launchedMode": state.launched_mode,
            "pendingMode": state.pending_mode,
        });
        let obj = payload
            .as_object_mut()
            .expect("status_event_locked payload is always a JSON object");
        // Optional fields are omitted entirely when absent, not sent as JSON `null`.
        if let Some(reason) = state.stop_reason {
            obj.insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        if let Some(detail) = &state.stop_detail {
            obj.insert("stopDetail".to_string(), Value::String(detail.clone()));
        }
        // Termination and progress fields are omitted entirely while absent, same rule as above.
        Self::insert_termination_and_progress_fields(obj, state);
        payload
    }

    /// Shared by the status event and `runtime_view`. `summary_fields` skips termination, which needs a file re-read per row.
    pub(super) fn insert_termination_and_progress_fields(
        obj: &mut serde_json::Map<String, Value>,
        state: &AgentState,
    ) {
        if state.termination.terminated_unexpectedly {
            obj.insert("terminatedUnexpectedly".to_string(), Value::Bool(true));
            if !state.termination.pending_tool_names.is_empty() {
                obj.insert(
                    "pendingToolNames".to_string(),
                    json!(state.termination.pending_tool_names),
                );
            }
        }
        if let Some(progress) = state.start_queue.to_wire() {
            obj.insert("startProgress".to_string(), progress);
        }
        if let Some(pause) = super::pause::wire_value(state) {
            obj.insert("pause".to_string(), pause.into());
        }
    }
}

impl SessionAgent {
    pub async fn status(&self) -> SessionStatus {
        self.state.lock().await.status
    }

    pub async fn available_commands(&self) -> Vec<Value> {
        self.state.lock().await.commands.clone()
    }
}
