// Split out of `launch.rs` to keep it under the 600-line cap. `sync_from_state` has no other caller in that file.

use serde_json::Value;

use crate::store::registry::SessionPatch;

use super::launch_support::truncate;
use super::{SessionAgent, MAX_MODEL_FIELD_LENGTH};

impl SessionAgent {
    /// Runs after `get_state` and each settle, persisting session fields once `messageCount > 0`.
    /// `stale_if` is re-checked before the write, so a later settle cannot be overwritten.
    pub(super) async fn sync_from_state(&self, state: &Value, stale_if: Option<(u64, u64)>) {
        if self.settle_is_stale(stale_if).await {
            return;
        }
        let session_file = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(str::to_string);
        let message_count = state
            .get("messageCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);

        let (existing_session_dir, existing_thinking_level) = {
            let registry = self.registry.lock().await;
            let session = registry.get_session(&self.session_id);
            (
                session.and_then(|s| s.session_dir.clone()),
                session.and_then(|s| s.last_thinking_level.clone()),
            )
        };

        let mut patch = SessionPatch {
            last_activity_at: Some(crate::ipc::now_iso8601()),
            ..Default::default()
        };
        if existing_session_dir.is_none() {
            if let Some(file) = &session_file {
                if let Some(parent) = std::path::Path::new(file).parent() {
                    patch.session_dir = Some(parent.to_string_lossy().into_owned());
                }
            }
        }
        if message_count > 0 {
            patch.last_message_count = Some(Some(message_count));
            patch.current_conversation = Some(session_file.clone());
        }
        if let Some(model) = state.get("model") {
            if let (Some(provider), Some(id)) = (
                model.get("provider").and_then(Value::as_str),
                model.get("id").and_then(Value::as_str),
            ) {
                if !provider.is_empty() && !id.is_empty() {
                    let name = model.get("name").and_then(Value::as_str);
                    patch.last_model = Some(crate::store::registry::LastModel {
                        provider: truncate(provider, MAX_MODEL_FIELD_LENGTH),
                        id: truncate(id, MAX_MODEL_FIELD_LENGTH),
                        name: name.map(|n| truncate(n, MAX_MODEL_FIELD_LENGTH)),
                    });
                    if let Some(t) = state.get("thinkingLevel").and_then(Value::as_str) {
                        patch.last_thinking_level = Some(Some(truncate(t, MAX_MODEL_FIELD_LENGTH)));
                    } else if existing_thinking_level
                        .as_deref()
                        .is_some_and(|v| v != "inherit")
                    {
                        // An absent `thinkingLevel` must clear a stale concrete level, but keep an explicit "inherit".
                        patch.last_thinking_level = Some(None);
                    }
                }
            }
        }
        // Re-checked right before the write, closing the gap after the entry check.
        if self.settle_is_stale(stale_if).await {
            return;
        }
        if self
            .registry
            .lock()
            .await
            .update_session(&self.session_id, patch)
            .await
            .is_ok()
        {
            self.events.emit_session_list_changed();
        }
        crate::session::readout::on_sync_from_state(self, state).await; // lane R5 (#788)
    }
}
