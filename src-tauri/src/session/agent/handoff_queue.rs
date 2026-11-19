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

/// Fills the slot, or refuses when a handoff is already queued. Runs under the agent's state lock, so two callers cannot both win.
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

/// Takes the one-shot notice meant for the agent's next user prompt.
pub(super) fn take_pending_notice(state: &mut AgentState) -> Option<String> {
    state.pending_agent_notice.take()
}

/// Puts the notice in front of the prompt text; the transcript keeps the user's own words.
pub(super) fn with_notice(notice: &str, text: &str) -> String {
    format!("[Refract] {notice}\n\n{text}")
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

/// The reason is flattened and capped, because it is prefixed onto the agent's next prompt.
fn failed_notice(reason: &str) -> String {
    format!(
        "Handoff failed: {}",
        crate::agent_tools::approval::clip_line(reason)
    )
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
        if let Some(reason) = self.settle_refusal(queued.sender.as_ref()).await {
            self.append_notice(format!("Handoff dropped: {reason}"), "error")
                .await;
            return;
        }
        let outcome = match queued.action {
            HandoffAction::New { prompt } => {
                self.start_handoff_conversation(prompt, queued.sender).await
            }
            HandoffAction::Switch { file } => self.switch_handoff_conversation(file).await,
        };
        if let Err(reason) = outcome {
            let notice = failed_notice(&reason);
            self.append_notice(notice.clone(), "error").await;
            self.state.lock().await.pending_agent_notice = Some(notice);
        }
    }

    /// Why the action queued mid-turn may no longer run: the call-time target-state checks again,
    /// since the Session can be paused, archived or deleted, or the sender moved, while the turn ran.
    async fn settle_refusal(&self, sender: Option<&(String, String)>) -> Option<String> {
        if crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting(&self.session_id) {
            return Some("the Session is being deleted".to_string());
        }
        if self.is_paused().await {
            return Some("the Session is paused".to_string());
        }
        let sessions = self.registry.lock().await.snapshot().sessions;
        let Some(me) = sessions.iter().find(|s| s.id == self.session_id) else {
            return Some("the Session no longer exists".to_string());
        };
        if me.archived_at.is_some() {
            return Some("the Session is archived".to_string());
        }
        let (_, caller_id) = sender?;
        let Some(caller) = sessions.iter().find(|s| s.id == *caller_id) else {
            return Some("the sending Session no longer exists".to_string());
        };
        if me.is_personal() || caller.repository_id != me.repository_id {
            return Some("the Session is outside the sending Session's Project".to_string());
        }
        let ancestors = crate::agent_tools::sessions_end::ancestors_of(&sessions, caller_id);
        if ancestors.contains(&self.session_id.as_str()) {
            return Some("the Session is now an ancestor of the sending Session".to_string());
        }
        None
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

/// The result of asking a Session to queue a handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueOutcome {
    /// The turn is running; the action waits for it to settle.
    Queued,
    /// The Session is between turns, so the caller runs the action itself.
    NotMidTurn,
}

impl SessionAgent {
    /// Queues a handoff when a turn is running. The mid-turn check and the queue happen under one
    /// lock, so a settle cannot slip in between and strand the action.
    pub async fn queue_handoff(
        &self,
        action: HandoffAction,
        sender: Option<(String, String)>,
    ) -> Result<QueueOutcome, AgentError> {
        let mut state = self.state.lock().await;
        // A launched Session sits at an odd generation before any turn, so the generation alone
        // cannot say a turn is running; only a busy status with an odd generation can.
        let mid_turn = matches!(
            state.status,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) && state.turn_generation % 2 == 1;
        if !mid_turn {
            return Ok(QueueOutcome::NotMidTurn);
        }
        try_queue(&mut state, action, sender)?;
        Ok(QueueOutcome::Queued)
    }
}

#[cfg(test)]
#[path = "handoff_queue.test.rs"]
mod tests;
