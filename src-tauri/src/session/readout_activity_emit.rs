// Session row Activity line (#526): streamed for every live Session, never gated by visibility, and
// never runs git. The payload carries agent-authored text, so it is never logged.
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::super::super::agent::SessionAgent;
use super::super::readout_todo::TodoPhaseState;
use super::super::State;

/// At most one `session:activity` per Session per second, with a trailing update.
const THROTTLE: Duration = Duration::from_secs(1);

/// Throttle bookkeeping; kept across the parent state's per-turn `reset`.
#[derive(Debug, Clone, Default)]
pub(in super::super) struct EmitState {
    last_sent: Value,
    last_at: Option<Instant>,
    trailing: bool,
}

/// `null` when no turn runs and no subagent does; a subagent outliving its turn still reports (#507).
fn activity_value(s: &State, running_subagents: u64) -> Value {
    if s.turn_started_at.is_none() {
        if running_subagents == 0 {
            return Value::Null;
        }
        return json!({ "runningSubagents": running_subagents, "todo": Value::Null });
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
        Some(task) => {
            let content = super::bounded(&task.content).unwrap_or_default();
            json!({ "number": done + 1, "total": open.len(), "content": content })
        }
        None => Value::Null,
    }
}

async fn running_subagents(agent: &SessionAgent) -> u64 {
    super::super::super::subagents::subagent_count(agent)
        .await
        .and_then(|count| count.get("running").and_then(Value::as_u64))
        .unwrap_or(0)
}

/// `SessionSummary.activity`, computed fresh; `null` with no live agent.
pub async fn current_activity(agent: Option<&SessionAgent>) -> Value {
    let Some(agent) = agent else {
        return Value::Null;
    };
    let running = running_subagents(agent).await;
    agent
        .with_readout_state(|s| activity_value(s, running))
        .await
}

/// Emits on change, or from a trailing timer when throttled; `null` always goes out at once.
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
