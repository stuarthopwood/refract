// The deferral slot (#1861): a handoff asked for mid-turn waits here and runs once the turn settles.
// One slot per agent, so a Session holds at most one queued action.

use std::time::Duration;

use tokio::sync::OwnedMutexGuard;

use super::detached_action::{finish_within, LostAction, Waited};
use super::start_with_message::{FirstMessage, StartStage, StartThenSendError};
use super::{AgentError, AgentState, SessionAgent, SessionStatus};
use crate::agent_tools::handoff_target::{check_target, needs_card, MOVED_OUT_OF_TREE};

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
    /// A card was shown and approved when the action was queued; the settle-time check needs it.
    pub asked: bool,
}

/// Fills the slot, or refuses when a handoff is already queued. Runs under the agent's state lock, so two callers cannot both win.
pub(super) fn try_queue(
    state: &mut AgentState,
    action: HandoffAction,
    sender: Option<(String, String)>,
    asked: bool,
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
        asked,
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

/// Takes every line meant for the agent's next user prompt, oldest first.
pub(super) fn take_pending_notice(state: &mut AgentState) -> Vec<String> {
    std::mem::take(&mut state.pending_agent_notice)
}

/// Puts the lines in front of the prompt text; the transcript keeps the user's own words.
pub(super) fn with_notice(lines: &[String], text: &str) -> String {
    if lines.is_empty() {
        return text.to_string();
    }
    let notice: Vec<String> = lines.iter().map(|line| format!("[Refract] {line}")).collect();
    format!("{}\n\n{text}", notice.join("\n"))
}

/// The first try plus one retry. A failure after the Conversation started retries the send only,
/// so a second Conversation never starts.
const ATTEMPTS: usize = 2;

/// The longest one action holds the Project's tree gate. One RPC may take its full 60 s timeout and
/// the rest of a healthy action is quick, so 90 s covers a slow start; a stuck omp then blocks a
/// re-parent, create or update for 90 s, not for the several minutes a chain of RPCs could take.
pub const ACTION_DEADLINE: Duration = Duration::from_secs(90);

/// Why a caller stopped waiting for an action that is still running past `ACTION_DEADLINE`.
pub fn still_running_reason() -> String {
    format!(
        "the action is still running after {} seconds; it keeps going and its result will show in the transcript",
        ACTION_DEADLINE.as_secs()
    )
}

/// Why a caller got no result from an action whose task ended unexpectedly.
pub fn lost_reason() -> String {
    "the action stopped unexpectedly; it may have partly run".to_string()
}

/// A failed action: `resend_only` is set once the new Conversation exists, so a retry repeats the send only.
struct ActionFailure {
    reason: String,
    resend_only: bool,
}

/// How one gated attempt ended.
enum Attempt {
    Done,
    /// Refused by the settle-time check; another try would be refused too.
    Dropped(String),
    Failed(ActionFailure),
    /// Past the deadline and not retried: the action may already have changed the Session. Its task
    /// posts the failure notice itself if it fails.
    StillRunning,
    /// The action's task ended without a result; not retried, for the same reason.
    Lost,
}

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
fn notice_with(prefix: &str, reason: &str) -> String {
    format!(
        "{prefix}: {}",
        crate::agent_tools::approval::clip_line(reason)
    )
}

fn failed_notice(reason: &str) -> String {
    notice_with("Handoff failed", reason)
}

fn dropped_notice(reason: &str) -> String {
    notice_with("Handoff dropped", reason)
}

impl SessionAgent {
    /// Runs the action queued during the turn that settled as `generation`; a follow-up turn that
    /// already started leaves it for its own settle, and a stop already emptied the slot.
    pub(super) async fn run_settled_handoff(&self, generation: u64) {
        self.run_settled_handoff_within(generation, ACTION_DEADLINE)
            .await;
    }

    async fn run_settled_handoff_within(&self, generation: u64, deadline: Duration) {
        let queued = {
            let mut state = self.state.lock().await;
            if state.status != SessionStatus::Idle || state.turn_generation != generation {
                return;
            }
            take_queued_handoff(&mut state, generation)
        };
        let Some(queued) = queued else { return };
        let mut resend_only = false;
        let mut notice = None;
        for _ in 0..ATTEMPTS {
            // Each attempt takes the gate and checks again, so a retry never holds the gate across the gap.
            match self.attempt_handoff(&queued, resend_only, deadline).await {
                Attempt::Done => {
                    notice = None;
                    break;
                }
                Attempt::Dropped(reason) => {
                    notice = Some(dropped_notice(&reason));
                    break;
                }
                Attempt::StillRunning => {
                    // An earlier attempt's failure is stale: the action is still running and may succeed.
                    notice = None;
                    break;
                }
                Attempt::Lost => {
                    notice = Some(failed_notice(&lost_reason()));
                    break;
                }
                Attempt::Failed(failed) => {
                    resend_only = failed.resend_only;
                    notice = Some(failed_notice(&failed.reason));
                }
            }
        }
        if let Some(notice) = notice {
            self.tell_agent_why(notice).await;
        }
    }

    /// The Project's tree gate for a cross-Session action; a self-handoff changes no tree link.
    /// Taken with no agent lock held: the gate only ever sits above the state and registry locks.
    async fn hold_tree_gate(&self, cross_session: bool) -> Option<OwnedMutexGuard<()>> {
        if !cross_session {
            return None;
        }
        let repository_id = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .and_then(|session| session.repository_id.clone())?;
        Some(crate::agent_tools::tree_gate::lock(&repository_id).await)
    }

    /// The settle-time check, then the action, under one hold of the tree gate. The action runs on its
    /// own task that owns the gate, so a slow one is waited for at most `deadline`, never cancelled.
    async fn attempt_handoff(
        &self,
        queued: &QueuedHandoff,
        resend_only: bool,
        deadline: Duration,
    ) -> Attempt {
        // The check and the action share one hold, so a re-parent cannot land between them (#1861).
        let gate = self.hold_tree_gate(queued.sender.is_some()).await;
        if let Some(reason) = self
            .settle_refusal(queued.sender.as_ref(), queued.asked)
            .await
        {
            return Attempt::Dropped(reason);
        }
        let entry_generation = self.state.lock().await.shutdown_generation;
        let runner = self.arc();
        let late = self.arc();
        let queued = queued.clone();
        let action = async move { runner.run_action(&queued, resend_only).await };
        // Only a failure that outlives the wait needs the task to say so; a waiting caller retries.
        let tell_late = move |outcome: Result<Result<(), ActionFailure>, LostAction>| async move {
            let reason = match outcome {
                Ok(Ok(())) => return,
                Ok(Err(failed)) => failed.reason,
                Err(LostAction) => lost_reason(),
            };
            late.tell_late(failed_notice(&reason), entry_generation)
                .await;
        };
        match finish_within(deadline, gate, action, tell_late).await {
            Waited::Done(Ok(())) => Attempt::Done,
            Waited::Done(Err(failed)) => Attempt::Failed(failed),
            Waited::StillRunning => Attempt::StillRunning,
            Waited::Lost => Attempt::Lost,
        }
    }

    async fn run_action(
        &self,
        queued: &QueuedHandoff,
        resend_only: bool,
    ) -> Result<(), ActionFailure> {
        match &queued.action {
            HandoffAction::New { prompt } => {
                self.start_handoff_conversation(prompt.clone(), queued.sender.clone(), resend_only)
                    .await
            }
            HandoffAction::Switch { file } => self.switch_handoff_conversation(file.clone()).await,
        }
    }

    /// A call-time action failed after its caller stopped waiting, so nobody else can say so; a
    /// Session deleted meanwhile has nobody to tell.
    pub async fn report_late_handoff_failure(&self, reason: &str) {
        if self.still_exists().await {
            self.tell_agent_why(failed_notice(reason)).await;
        }
    }

    /// The late notice of a settled action, dropped once the Session is deleted or was shut down
    /// since the action began, as its transcript is gone or no longer the one that was handed off.
    async fn tell_late(&self, notice: String, entry_generation: u64) {
        if self.still_exists().await
            && self.state.lock().await.shutdown_generation == entry_generation
        {
            self.tell_agent_why(notice).await;
        }
    }

    async fn still_exists(&self) -> bool {
        !crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting(&self.session_id)
            && self
                .registry
                .lock()
                .await
                .get_session(&self.session_id)
                .is_some()
    }

    /// Shows the developer the notice and keeps it for the agent's next prompt.
    async fn tell_agent_why(&self, notice: String) {
        self.append_notice(notice.clone(), "error").await;
        self.state.lock().await.pending_agent_notice.push(notice);
    }

    /// Why the action queued mid-turn may no longer run: the call-time target checks again, since
    /// the Session can be paused, archived or deleted, or the sender moved, while the turn ran.
    /// An action queued without a card must not run on a Session that is now outside the sender's tree.
    async fn settle_refusal(
        &self,
        sender: Option<&(String, String)>,
        asked: bool,
    ) -> Option<String> {
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
        let relationship = match check_target(&sessions, caller_id, &self.session_id) {
            Ok((_, relationship)) => relationship,
            Err(refusal) => return Some(refusal.settle_reason().to_string()),
        };
        (!asked && needs_card(relationship, self.is_yolo_session(caller_id).await))
            .then(|| MOVED_OUT_OF_TREE.to_string())
    }

    /// Whether the sending Session runs in `yolo`; unknown at shutdown, which reads as not.
    async fn is_yolo_session(&self, id: &str) -> bool {
        match self.tool_manager() {
            Some(manager) => manager.get_or_create_agent(id).tool_is_yolo().await,
            None => false,
        }
    }

    async fn start_handoff_conversation(
        &self,
        prompt: String,
        sender: Option<(String, String)>,
        resend_only: bool,
    ) -> Result<(), ActionFailure> {
        let message = crate::agent_tools::envelope::first_message(sender.as_ref(), prompt);
        let first = FirstMessage {
            text: message.text,
            handoff_note: message.handoff_note,
        };
        let sent = if resend_only {
            self.resend_first_message(first)
                .await
                .map_err(|error| StartThenSendError {
                    stage: StartStage::AfterNew,
                    error,
                })
        } else {
            self.start_conversation_then_send(first).await
        };
        sent.map_err(|failed| ActionFailure {
            resend_only: failed.stage == StartStage::AfterNew,
            reason: failure_reason(failed),
        })
    }

    async fn switch_handoff_conversation(&self, file: String) -> Result<(), ActionFailure> {
        self.open_conversation(file)
            .await
            .map_err(|error| ActionFailure {
                reason: error.message,
                resend_only: false,
            })?;
        self.events
            .emit_session_conversation_changed(&self.session_id);
        Ok(())
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
        asked: bool,
    ) -> Result<QueueOutcome, AgentError> {
        let mut state = self.state.lock().await;
        // A launched Session sits at an odd generation before any turn, so the generation alone cannot
        // say a turn is running. `begin_turn` flips both together, so busy status plus odd is a turn.
        let mid_turn = matches!(
            state.status,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) && state.turn_generation % 2 == 1;
        if !mid_turn {
            return Ok(QueueOutcome::NotMidTurn);
        }
        try_queue(&mut state, action, sender, asked)?;
        Ok(QueueOutcome::Queued)
    }
}

#[cfg(test)]
#[path = "handoff_queue.test.rs"]
mod tests;

#[cfg(test)]
#[path = "handoff_queue_gate.test.rs"]
mod gate_tests;

#[cfg(test)]
#[path = "handoff_queue_turn.test.rs"]
mod turn_tests;

#[cfg(test)]
#[path = "notice_lines.test.rs"]
mod notice_tests;
