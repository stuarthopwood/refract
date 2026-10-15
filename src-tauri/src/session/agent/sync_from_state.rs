// Split out of `launch.rs` (round 3, 2026-10-15, issue #564, #806 600-line cap): the round-3
// code-reviewer fix below grew `launch.rs` to 615 lines. `sync_from_state` is a single, cohesive
// method with no other caller in this file, so it moves to its own sibling module rather than
// trimming something else -- same pattern `thinking_level.rs` already established for splitting
// one `SessionAgent` method out of a file that would otherwise cross the cap (`launch_support.rs`
// itself was split out of `launch.rs` the same way, round 4, 2026-10-14).

use serde_json::Value;

use crate::store::registry::SessionPatch;

use super::launch_support::truncate;
use super::{SessionAgent, MAX_MODEL_FIELD_LENGTH};

impl SessionAgent {
    /// Runs after the initial `get_state` and after every `session_settled` (port of
    /// `SessionAgent.ts`'s own `syncFromState`): persists `sessionDir`/`currentConversation`/
    /// `lastMessageCount`/`lastModel`/`lastThinkingLevel` once `messageCount > 0`. `stale_if`
    /// (settle-time callers) is checked by `settle_is_stale` both here and again right before the
    /// write below, so a later settle/reset landing in the gap can never write stale data over it.
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
                        // Gate round 3 fix (code-reviewer HIGH): a model/role switch (or a
                        // relaunch after one) that leaves `thinkingLevel` OUT of this `get_state`
                        // must clear a stale CONCRETE level (e.g. "high") the new model/role no
                        // longer reports -- only an explicitly-persisted "inherit" survives an
                        // absent report (thinking_level.rs's own comment above: omp leaves the
                        // field out only for `inherit` itself or a model with no effort control,
                        // so a concrete value stored next to an absent one is always stale).
                        // Never touches a Session where nothing was ever stored.
                        patch.last_thinking_level = Some(None);
                    }
                }
            }
        }
        // Gate-fix (#856, round 2): re-checked again, right before the write -- the entry check's only remaining gap.
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
