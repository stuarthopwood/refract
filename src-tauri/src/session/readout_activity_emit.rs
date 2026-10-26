// Issue #526 (spec 001 FR-108 to FR-110, contracts/ipc.md `session:activity`): the Session row
// Activity line's raw inputs, streamed for EVERY live Session -- unlike `readout:update`, never
// gated by visibility, and never doing any git work. A child module of `readout_activity` (#806
// file-size discipline: `readout.rs` sits at its 600-line cap) so it can read the parent
// `readout::State`'s retained todo tree, turn timer and activity fields directly. Every trigger
// `schedule_readout_update` already receives (frames, todo tool ends, subagent changes, settle,
// exit, Conversation switch) also calls `emit_activity` here, before that function's own
// debounce. The payload carries agent-authored text, so it is never logged.
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::super::super::agent::SessionAgent;
use super::super::readout_todo::TodoPhaseState;
use super::super::State;

/// FR-109: at most one `session:activity` per Session per second, with a trailing update.
const THROTTLE: Duration = Duration::from_secs(1);

/// The last value sent and when, held inside `ActivityState` so it survives that state's own
/// per-turn `reset`.
#[derive(Debug, Clone, Default)]
pub(in super::super) struct EmitState {
    last_sent: Value,
    last_at: Option<Instant>,
    trailing: bool,
}

/// `SessionActivity` or `null` (not working: no turn running on this agent). `todo` mirrors the
/// renderer's `deriveTodoTotals`/`deriveCurrentTask` (`todoDerive.ts`): `total` excludes
/// abandoned tasks, `done` counts completed ones, the current task is the first `in_progress`
/// one (else the first still-open one); `null` when there is no plan or every open task is done.
fn activity_value(s: &State, running_subagents: u64) -> Value {
    if s.turn_started_at.is_none() {
        return Value::Null;
    }
    let mut activity = json!({
        "runningSubagents": running_subagents,
        "todo": current_todo(s.todo_phases.as_ref()),
    });
    s.activity.write_into(&mut activity);
    activity
}

fn current_todo(phases: Option<&Vec<TodoPhaseState>>) -> Value {
    let Some(phases) = phases else {
        return Value::Null;
    };
    let open: Vec<_> = phases
        .iter()
        .flat_map(|p| p.tasks.iter())
        .filter(|t| t.status != "abandoned")
        .collect();
    let done = open.iter().filter(|t| t.status == "completed").count();
    if open.is_empty() || done == open.len() {
        return Value::Null;
    }
    let current = open
        .iter()
        .find(|t| t.status == "in_progress")
        .or_else(|| open.iter().find(|t| t.status != "completed"));
    match current {
        Some(task) => json!({ "number": done + 1, "total": open.len(), "content": task.content }),
        None => Value::Null,
    }
}

async fn running_subagents(agent: &SessionAgent) -> u64 {
    super::super::super::subagents::subagent_count(agent)
        .await
        .and_then(|count| count.get("running").and_then(Value::as_u64))
        .unwrap_or(0)
}

/// `SessionSummary.activity` for `sessions.list()`: the current value, computed fresh; `null`
/// for a Session with no live agent this run.
pub async fn current_activity(agent: Option<&SessionAgent>) -> Value {
    let Some(agent) = agent else {
        return Value::Null;
    };
    let running = running_subagents(agent).await;
    agent
        .with_readout_state(|s| activity_value(s, running))
        .await
}

/// Emits `session:activity` when the value changed: immediately when the last emit was over a
/// second ago (or the value is `null`, so a row reverts at once on turn end or stop), otherwise
/// once from a trailing timer that recomputes the latest value when it fires.
pub(in super::super) async fn emit_activity(agent: &SessionAgent) {
    if let Some(delay) = evaluate(agent, false).await {
        let agent = agent.arc();
        tokio::spawn(async move {
            let mut delay = delay;
            loop {
                tokio::time::sleep(delay).await;
                match evaluate(&agent, true).await {
                    Some(next) => delay = next,
                    None => return,
                }
            }
        });
    }
}

/// Returns the delay a newly armed trailing timer must wait, or `None` when nothing is owed.
async fn evaluate(agent: &SessionAgent, from_timer: bool) -> Option<Duration> {
    let running = running_subagents(agent).await;
    let now = Instant::now();
    let (send, delay) = agent
        .with_readout_state(|s| {
            let value = activity_value(s, running);
            let emit = &mut s.activity.emit;
            if from_timer {
                emit.trailing = false;
            }
            if value == emit.last_sent {
                return (None, None);
            }
            if !value.is_null() {
                if emit.trailing {
                    return (None, None);
                }
                if let Some(since) = emit.last_at.map(|at| now.duration_since(at)) {
                    if since < THROTTLE {
                        emit.trailing = true;
                        return (None, Some(THROTTLE - since));
                    }
                }
            }
            emit.last_sent = value.clone();
            emit.last_at = Some(now);
            (Some(value), None)
        })
        .await;
    if let Some(value) = send {
        agent
            .events()
            .emit_session_activity(agent.session_id(), value);
    }
    delay
}
