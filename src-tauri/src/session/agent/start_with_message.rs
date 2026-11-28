// Starts a fresh Conversation and sends its first message (#1861). The #1212 summary handoff,
// agent handoffs and #1827's `/new <prompt>` share it.

use serde_json::{json, Value};

use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

/// The message that opens the new Conversation. `text` is sent as given, never wrapped.
pub struct FirstMessage {
    pub text: String,
    /// The text is an agent's handoff note: the Conversation is recorded so its first message is labelled.
    pub handoff_note: bool,
}

/// Where a failure happened. After `AfterNew` the old Conversation is gone, so a caller retries
/// the send only and never starts another Conversation.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum StartStage {
    BeforeNew,
    AfterNew,
}

#[derive(Debug)]
pub struct StartThenSendError {
    pub stage: StartStage,
    pub error: AgentError,
}

impl SessionAgent {
    /// A Stopped Session launches on a new Conversation; an idle live one starts it in place.
    /// Order is fixed: the Conversation exists, the event fires, the note flag is set, then the send.
    pub async fn start_conversation_then_send(
        &self,
        first: FirstMessage,
    ) -> Result<(), StartThenSendError> {
        let started = if self.status().await == SessionStatus::Stopped {
            self.start_with_conversation(None).await
        } else {
            self.start_new_conversation().await
        };
        started.map_err(|error| StartThenSendError {
            stage: StartStage::BeforeNew,
            error,
        })?;
        self.events
            .emit_session_conversation_changed(&self.session_id);
        let mut recorded = false;
        if first.handoff_note {
            self.state.lock().await.handoff.note_live = true;
            recorded = self.record_note_file().await;
        }
        self.send(first.text, None)
            .await
            .map_err(|error| StartThenSendError {
                stage: StartStage::AfterNew,
                error,
            })?;
        if first.handoff_note && !recorded {
            // omp may not name the file until the first message exists.
            self.record_note_file().await;
        }
        Ok(())
    }

    /// The retry after an `AfterNew` failure: the Conversation exists, so only the send is repeated.
    /// The sidecar is written again because the first attempt may have failed before the file was named.
    pub(super) async fn resend_first_message(&self, first: FirstMessage) -> Result<(), AgentError> {
        self.send(first.text, None).await?;
        if first.handoff_note {
            self.record_note_file().await;
        }
        Ok(())
    }

    /// Records the current Conversation file in the handoff sidecar. `Session.current_conversation`
    /// stays `None` until a message exists, so the file name comes from omp's `get_state`.
    async fn record_note_file(&self) -> bool {
        let Some(proc) = self.state.lock().await.process.clone() else {
            return false;
        };
        let res = match proc
            .request(json!({ "type": "get_state" }), DEFAULT_REQUEST_TIMEOUT_MS)
            .await
        {
            Ok(res) if res.get("success").and_then(Value::as_bool) == Some(true) => res,
            _ => return false,
        };
        let Some(file) = res
            .get("data")
            .and_then(|d| d.get("sessionFile"))
            .and_then(Value::as_str)
        else {
            return false;
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        crate::store::handoff_notes::record(file, now_ms).await;
        true
    }
}

#[cfg(test)]
#[path = "start_with_message.test.rs"]
mod tests;
