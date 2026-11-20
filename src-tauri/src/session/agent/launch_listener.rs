// Reattach verification and the omp frame listener, split from `launch.rs` to keep it under the
// file cap.

use std::sync::Arc;

use serde_json::{json, Value};

use super::launch_support::{assert_conversation_file_exists, verify_reattach};
use super::{SessionAgent, DEFAULT_REQUEST_TIMEOUT_MS};
use crate::omp::process::{OmpProcess, ProcessEvent};
use crate::store::registry::Session;

impl SessionAgent {
    /// Switches to the Session's conversation (skipped when new), then verifies with `get_state`.
    /// Returns `Err` on failure; the caller stops `proc`.
    pub(super) async fn attach_and_verify(
        &self,
        proc: &OmpProcess,
        session: &Session,
    ) -> Result<Value, String> {
        if let Some(conversation) = &session.current_conversation {
            assert_conversation_file_exists(conversation).await?;
            let switch_res = proc
                .request(
                    json!({ "type": "switch_session", "sessionPath": conversation }),
                    DEFAULT_REQUEST_TIMEOUT_MS,
                )
                .await
                .map_err(|err| err.to_string())?;
            let cancelled = switch_res
                .get("data")
                .and_then(|d| d.get("cancelled"))
                .and_then(Value::as_bool);
            if switch_res.get("success").and_then(Value::as_bool) != Some(true)
                || cancelled != Some(false)
            {
                return Err(format!(
                    "switch_session failed or was cancelled for {conversation}"
                ));
            }
        }
        let state_res = proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
            .map_err(|err| err.to_string())?;
        if state_res.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "get_state failed: {}",
                state_res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            ));
        }
        let data = state_res.get("data").cloned().unwrap_or(Value::Null);
        if let Some(conversation) = &session.current_conversation {
            verify_reattach(conversation, &data)?;
        }
        Ok(data)
    }
    // `sync_from_state` lives in `sync_from_state.rs`.
    pub(super) fn spawn_frame_listener(
        &self,
        proc: Arc<OmpProcess>,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<ProcessEvent>,
    ) {
        let agent = self.arc();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Some(ProcessEvent::Frame(frame)) => agent.handle_frame(frame).await,
                    Some(ProcessEvent::StartProgress { stage, elapsed_ms }) => {
                        // Extension point for start-progress handling.
                        crate::session::model::on_start_progress(&agent, stage, elapsed_ms).await;
                        crate::session::readout::on_start_progress(&agent, stage, elapsed_ms).await;
                        crate::session::side_chat::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::start_queue::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::subagents::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                        crate::session::termination::on_start_progress(&agent, stage, elapsed_ms)
                            .await;
                    }
                    Some(ProcessEvent::Exit { code, requested }) => {
                        let (is_current, stop_requested, was_already_stopped, epoch_at_exit) =
                            agent.handle_exit(&proc, code, requested).await;
                        // Extension point for exit handling.
                        crate::session::model::on_exit(&agent, code, requested).await;
                        crate::session::side_chat::on_exit(&agent, code, requested).await;
                        // Gated on `is_current`, so a stale exit cannot affect a newer life.
                        if is_current {
                            crate::session::working_mode::on_exit(&agent, requested).await;
                            crate::session::advisor::on_exit(&agent).await;
                            crate::session::readout::on_exit(&agent, code, requested).await;
                            crate::session::subagents::on_exit(
                                &agent,
                                code,
                                requested,
                                stop_requested,
                            )
                            .await;
                            crate::session::start_queue::on_exit(&agent, code, stop_requested)
                                .await;
                            crate::session::termination::on_exit(
                                &agent,
                                code,
                                requested,
                                stop_requested,
                                was_already_stopped,
                                epoch_at_exit,
                            )
                            .await;
                        }
                        break;
                    }
                    // The unbounded channel closes only when the process is gone.
                    None => break,
                }
            }
        });
    }
}
