// Token guard Hand off (#1212, spec 021 Lane B): asks the agent for a handoff summary, starts a
// fresh Conversation in the same Session, and sends the summary as its first message. See
// `mod.rs`'s own header for this module's place in the `agent/` split.

use std::time::Duration;

use super::{AgentError, SessionAgent, SessionStatus};

const SUMMARY_PROMPT: &str = "Write a handoff summary so a fresh conversation can continue this work: the goal, what is done, decisions made, files touched, open problems, and the exact next step. Reply with the summary only; do not call any tools.";
const SUMMARY_TIMEOUT_SECS: u64 = 180;
const POLL_MS: u64 = 100;

impl SessionAgent {
    /// `tokenGuard.handoff`: only while idle with a live process. A failure before the new
    /// Conversation exists leaves the old one untouched.
    pub async fn hand_off(&self) -> Result<(), AgentError> {
        let before = {
            let state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.process.is_none() {
                return Err(AgentError::new(
                    "not-idle",
                    "Hand off needs the Session to be idle.".to_string(),
                ));
            }
            state.turn_generation
        };
        crate::session::token_guard::begin_summary_capture(self).await;
        let sent = self.send(SUMMARY_PROMPT.to_string(), None).await;
        let settled = match sent {
            Ok(_) => self.wait_for_settle_after(before).await,
            Err(err) => Err(err),
        };
        let summary = crate::session::token_guard::end_summary_capture(self).await;
        settled?;
        let summary = summary.filter(|s| !s.trim().is_empty()).ok_or_else(|| {
            AgentError::new(
                "handoff-empty",
                "The agent returned no summary, so nothing was handed off.".to_string(),
            )
        })?;
        self.start_new_conversation().await?;
        self.send(
            format!("Continuing from a previous conversation. Handoff summary:\n\n{summary}"),
            None,
        )
        .await
        .map_err(|err| {
            AgentError::new(
                "handoff-send-failed",
                format!(
                    "The new Conversation was started but the summary could not be sent: {}",
                    err.message
                ),
            )
        })?;
        Ok(())
    }

    /// Polls for a later, even (settled) turn generation with the Session idle again.
    async fn wait_for_settle_after(&self, before: u64) -> Result<(), AgentError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(SUMMARY_TIMEOUT_SECS);
        loop {
            {
                let state = self.state.lock().await;
                if state.status == SessionStatus::Stopped || state.process.is_none() {
                    return Err(AgentError::new(
                        "handoff-stopped",
                        "The Session stopped before the summary finished.".to_string(),
                    ));
                }
                if state.status == SessionStatus::Idle
                    && state.turn_generation > before
                    && state.turn_generation % 2 == 0
                {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AgentError::new(
                    "handoff-timeout",
                    "The summary took too long; nothing was handed off.".to_string(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
    }
}
