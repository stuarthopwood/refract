// Runs the action behind `new` and `switch` (#1861). Once started it always finishes: dropping it
// between omp's reply and the local state patch would leave omp and the UI on different Conversations.

use tokio::sync::OwnedMutexGuard;

use super::{ConvHost, ToolError, OUTCOME_UNKNOWN};
use crate::agent_tools::envelope;
use crate::session::agent::{
    finish_within, lost_reason, still_running_reason, HandoffAction, QueueOutcome, Waited,
    ACTION_DEADLINE,
};

/// What became of the action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispatch {
    /// Held until the target's turn settles.
    Scheduled,
    /// Done now: the target was between turns or Stopped.
    Done,
}

/// Queues the action when the target is mid-turn; otherwise runs it once, launching a Stopped
/// target first, and tells the caller if that fails (the deferred run retries, see `handoff_queue`).
/// `asked` is whether a card was shown and approved, which the deferred run needs to check again.
/// The action runs on its own task that owns `tree`, so the caller waits at most `ACTION_DEADLINE`:
/// past it the action keeps going and keeps the gate, and is never retried.
pub(super) async fn dispatch<H: ConvHost + Clone>(
    host: &H,
    id: &str,
    action: HandoffAction,
    sender: Option<(String, String)>,
    asked: bool,
    tree: Option<OwnedMutexGuard<()>>,
) -> Result<Dispatch, ToolError> {
    let (runner, reporter) = (host.clone(), host.clone());
    let (target, late_target) = (id.to_string(), id.to_string());
    let run = async move { run_action(&runner, &target, action, sender, asked).await };
    // Only a failure after the caller stopped waiting needs the task to say so.
    let tell_late = move |result: Result<Dispatch, ToolError>| async move {
        if let Err(failed) = result {
            reporter.late_failure(&late_target, &failed.message).await;
        }
    };
    match finish_within(ACTION_DEADLINE, tree, run, tell_late).await {
        Waited::Done(result) => result,
        Waited::StillRunning => Err(ToolError::new(OUTCOME_UNKNOWN, still_running_reason())),
        Waited::Lost => Err(ToolError::new(OUTCOME_UNKNOWN, lost_reason())),
    }
}

async fn run_action<H: ConvHost>(
    host: &H,
    id: &str,
    action: HandoffAction,
    sender: Option<(String, String)>,
    asked: bool,
) -> Result<Dispatch, ToolError> {
    if host
        .queue(id, action.clone(), sender.clone(), asked)
        .await?
        == QueueOutcome::Queued
    {
        return Ok(Dispatch::Scheduled);
    }
    match action {
        HandoffAction::New { prompt } => {
            let first = envelope::first_message(sender.as_ref(), prompt);
            host.start_new(id, first).await?;
        }
        HandoffAction::Switch { file } => host.switch(id, file).await?,
    }
    Ok(Dispatch::Done)
}
