// The deferral slot (#1861): a handoff asked for mid-turn waits here and runs once the turn settles.
// One slot per agent, so a Session holds at most one queued action.

use super::{AgentError, AgentState};

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

// The slot is filled and drained by the tool and the settle handler (T005-T007).
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
#[allow(dead_code)]
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
#[allow(dead_code)]
pub(super) fn clear(state: &mut AgentState) {
    state.queued_handoff = None;
}

#[cfg(test)]
#[path = "handoff_queue.test.rs"]
mod tests;
