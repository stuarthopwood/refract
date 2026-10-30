// Two tiny public status accessors, split out of `mod.rs` (issue #806, 600-line cap: the #572
// ask-dialog `ask_dialog_enabled` field addition pushed it one line over). No behaviour change --
// moved verbatim. See `mod.rs`'s own header for this module's place in the `agent/` split and the
// lane extension contract. Issue #911: `status_event_locked`/`insert_termination_and_progress_fields`
// added below, same reason (mod.rs was again sitting at the 600-line cap with zero headroom) --
// Decided (Skippy, delegated by Stuart 2026-10-18): a pure move here, not a baseline bump, per the
// same #806 precedent above.

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
        // `stopReason`/`stopDetail` are TS `?:` optional fields (the renderer checks
        // `=== undefined`, ChatPane.tsx:205): omitted entirely when absent, not sent as JSON
        // `null` (code-review finding, 2026-10-13).
        if let Some(reason) = state.stop_reason {
            obj.insert("stopReason".to_string(), Value::String(reason.to_string()));
        }
        if let Some(detail) = &state.stop_detail {
            obj.insert("stopDetail".to_string(), Value::String(detail.clone()));
        }
        // Lane R3 (issue #786): `terminatedUnexpectedly`/`pendingToolNames` (`session::
        // termination`'s own `on_exit` hook) and `startProgress` (`session::start_queue`'s own
        // `on_start_progress` hook), each omitted entirely while absent -- same gate rule as
        // `stopReason`/`stopDetail` above.
        Self::insert_termination_and_progress_fields(obj, state);
        payload
    }

    /// Lane R3 (#786): shared by `status_event_locked` (session:status event) and `runtime_view`
    /// (`SessionSnapshot.runtime`) so both stay in lock-step. `summary_fields` skips it: progress
    /// yes (#985, cheap, already in memory), termination no (needs a fresh file re-read per row).
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
