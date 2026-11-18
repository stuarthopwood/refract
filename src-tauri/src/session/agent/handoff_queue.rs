// The deferral slot (#1861): a handoff asked for mid-turn waits here and runs once the turn settles.
// One slot per agent, so a Session holds at most one queued action.

use super::start_with_message::{FirstMessage, StartStage, StartThenSendError};
use super::{AgentError, AgentState, SessionAgent, SessionStatus};

/// What a queued handoff does once the turn has settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffAction {
    New { prompt: String },
    Switch { file: String },
}

/// A handoff waiting for its turn to settle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedHandoff {
    /// `turn_generation` when queued; odd, because the turn was running.
    pub generation: u64,
    pub action: HandoffAction,
    /// `(name, id)` for the message envelope; `None` for a self-handoff.
    pub sender: Option<(String, String)>,
}

// The slot is filled by the tool (T007) and drained by `run_settled_handoff` and the stop paths.
/// Fills the slot, or refuses when a handoff is already queued. Runs under the agent's state lock, so two callers cannot both win.
#[allow(dead_code)]
pub(super) fn try_queue(
    state: &mut AgentState,
    action: HandoffAction,
    sender: Option<(String, String)>,
) -> Result<(), AgentError> {
    if state.queued_handoff.is_some() {
        return Err(AgentError::new(
            "invalid-state",
            "a handoff is already queued for this turn",
        ));
    }
    state.queued_handoff = Some(QueuedHandoff {
        generation: state.turn_generation,
        action,
        sender,
    });
    Ok(())
}

/// Empties the slot when it was queued in a turn older than `settled_generation`; a newer turn's action stays.
pub(super) fn take_queued_handoff(
    state: &mut AgentState,
    settled_generation: u64,
) -> Option<QueuedHandoff> {
    if state.queued_handoff.as_ref()?.generation < settled_generation {
        state.queued_handoff.take()
    } else {
        None
    }
}

/// Drops any queued handoff, for stop and shutdown paths.
pub(super) fn clear(state: &mut AgentState) {
    state.queued_handoff = None;
}

/// The first try plus one retry. A failure after the Conversation started retries the send only,
/// so a second Conversation never starts.
const ATTEMPTS: usize = 2;

fn failure_reason(failed: StartThenSendError) -> String {
    match failed.stage {
        StartStage::BeforeNew => failed.error.message,
        StartStage::AfterNew => format!(
            "the new Conversation was started but its first message could not be sent: {}",
            failed.error.message
        ),
    }
}

impl SessionAgent {
    /// Runs the action queued during the turn that settled as `generation`. The slot is read under the
    /// lock that checks the Session is still idle on that settle: a follow-up turn that already
    /// started leaves the action for its own settle (A3), and a stop already emptied the slot.
    /// A second failure leaves the old Conversation current and posts "Handoff failed" for the agent's next turn.
    pub(super) async fn run_settled_handoff(&self, generation: u64) {
        let queued = {
            let mut state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.turn_generation != generation {
                return;
            }
            take_queued_handoff(&mut state, generation)
        };
        let Some(queued) = queued else { return };
        let outcome = match queued.action {
            HandoffAction::New { prompt } => {
                self.start_handoff_conversation(prompt, queued.sender).await
            }
            HandoffAction::Switch { file } => self.switch_handoff_conversation(file).await,
        };
        if let Err(reason) = outcome {
            self.append_notice(format!("Handoff failed: {reason}"), "error")
                .await;
        }
    }

    async fn start_handoff_conversation(
        &self,
        prompt: String,
        sender: Option<(String, String)>,
    ) -> Result<(), String> {
        // Another Session's prompt travels in its envelope; a self-handoff is the raw note.
        let handoff_note = sender.is_none();
        let text = match &sender {
            Some((name, id)) => crate::agent_tools::envelope::wrap(name, id, &prompt),
            None => prompt,
        };
        let first = || FirstMessage {
            text: text.clone(),
            handoff_note,
        };
        let mut conversation_started = false;
        let mut last_failure = None;
        for _ in 0..ATTEMPTS {
            let attempt = if conversation_started {
                self.resend_first_message(first())
                    .await
                    .map_err(|error| StartThenSendError {
                        stage: StartStage::AfterNew,
                        error,
                    })
            } else {
                self.start_conversation_then_send(first()).await
            };
            match attempt {
                Ok(()) => return Ok(()),
                Err(failed) => {
                    conversation_started = failed.stage == StartStage::AfterNew;
                    last_failure = Some(failed);
                }
            }
        }
        Err(last_failure.map_or_else(String::new, failure_reason))
    }

    async fn switch_handoff_conversation(&self, file: String) -> Result<(), String> {
        let mut last_error: Option<AgentError> = None;
        for _ in 0..ATTEMPTS {
            match self.open_conversation(file.clone()).await {
                Ok(()) => {
                    self.events
                        .emit_session_conversation_changed(&self.session_id);
                    return Ok(());
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.map_or_else(String::new, |error| error.message))
    }
}

#[cfg(test)]
#[path = "handoff_queue.test.rs"]
mod tests;
