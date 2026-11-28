// Which subagents a Session keeps: running ones plus the current turn's finished ones, whole Stages
// at a time, and the counts behind the composer pill (#1085, FR-201 to FR-203).

use std::collections::HashSet;

use serde_json::{json, Value};

use super::{
    emit_subagents_update, summaries_to_value, SessionAgent, State, SummaryEntry, SummaryStatus,
};

/// The key a Stage is grouped by; the call id stands in when no assistant message was seen.
fn stage_of(entry: &SummaryEntry) -> &str {
    if entry.stage_key.is_empty() {
        &entry.tool_call_id
    } else {
        &entry.stage_key
    }
}

/// Remembers the id of each assistant message as it starts: the transcript groups a Stage by it.
pub(super) fn note_message_start(state: &mut State, frame: &Value) {
    let role = frame
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str);
    let id = frame.get("messageId").and_then(Value::as_str).unwrap_or("");
    if role == Some("assistant") && !id.is_empty() {
        state.current_message_id = id.to_string();
    }
}

/// Gives a freshly created agent its Stage key and turn.
pub(super) fn stamp_new_entry(state: &State, entry: &mut SummaryEntry) {
    entry.stage_key = state.current_message_id.clone();
    entry.turn = state.turn;
}

/// Drops `doomed` summaries with their streams; true when anything went. A removed visible agent
/// stops being forwarded, since nothing is left to patch.
fn remove_ids(state: &mut State, doomed: &HashSet<String>) -> bool {
    if doomed.is_empty() {
        return false;
    }
    state.summaries.retain(|e| !doomed.contains(&e.id));
    for id in doomed {
        state.streams.remove(id);
        state.stream_ids.remove(id);
    }
    if state
        .visible_id
        .as_ref()
        .is_some_and(|visible| doomed.contains(visible))
    {
        state.visible_id = None;
        state.pending_patch_ops.clear();
    }
    true
}

/// Pushes the shortened list to an open panel and refreshes the pill that counts it.
async fn publish(agent: &SessionAgent, list: Option<Value>, readout_stale: bool) {
    if let Some(value) = list {
        emit_subagents_update(agent, value).await;
    }
    if readout_stale {
        super::super::readout::schedule_readout_update(agent).await;
    }
}

/// At `agent_start` the previous turn ends: every Stage that is all settled leaves memory and the
/// panel, while a Stage with any running agent stays whole, even across the turn boundary.
pub(super) async fn prune_for_new_turn(agent: &SessionAgent) {
    let (list, had_any) = agent
        .with_subagents_state(|s| {
            s.turn += 1;
            let had_any = !s.summaries.is_empty();
            let running: HashSet<&str> = s
                .summaries
                .iter()
                .filter(|e| e.status == SummaryStatus::Running)
                .map(stage_of)
                .collect();
            let doomed: HashSet<String> = s
                .summaries
                .iter()
                .filter(|e| !running.contains(stage_of(e)))
                .map(|e| e.id.clone())
                .collect();
            let changed = remove_ids(s, &doomed);
            (changed.then(|| summaries_to_value(&s.summaries)), had_any)
        })
        .await;
    publish(agent, list, had_any).await;
}

/// Suffix of the id of the lone notice that stands in for an agent's output when its process died.
pub(super) const NO_OUTPUT_NOTICE_SUFFIX: &str = ":reattach-notice";

/// True when the agent has no output left to show: no stream, or only the "No live output" notice.
fn lacks_output(state: &State, id: &str) -> bool {
    state.streams.get(id).is_none_or(|rows| {
        rows.iter().all(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .is_some_and(|row_id| row_id.ends_with(NO_OUTPUT_NOTICE_SUFFIX))
        })
    })
}

/// On reattach a new process cannot confirm a `Running` agent and has no output for it, and an
/// agent left with nothing to show (its stream freed, or only the "No live output" notice) has
/// none either: both leave at once.
pub(super) async fn drop_unavailable(agent: &SessionAgent) {
    let list = agent
        .with_subagents_state(|s| {
            let doomed: HashSet<String> = s
                .summaries
                .iter()
                .filter(|e| e.status == SummaryStatus::Running || lacks_output(s, &e.id))
                .map(|e| e.id.clone())
                .collect();
            remove_ids(s, &doomed).then(|| summaries_to_value(&s.summaries))
        })
        .await;
    let changed = list.is_some();
    publish(agent, list, changed).await;
}

/// Counts for `SessionReadout.subagentCount`; `None` hides the pill. While anything runs the
/// counts cover the whole retained list. Otherwise the pill shows only the failure of the current
/// turn's last Stage, so only that Stage is counted, and it is hidden when that Stage had none.
pub(in crate::session) async fn subagent_count(agent: &SessionAgent) -> Option<Value> {
    agent.with_subagents_state(|s| count_value(s)).await
}

fn count_value(state: &State) -> Option<Value> {
    let running = state
        .summaries
        .iter()
        .any(|e| e.status == SummaryStatus::Running);
    let scope: Vec<&SummaryEntry> = if running {
        state.summaries.iter().collect()
    } else {
        let last = state.summaries.iter().rfind(|e| e.turn == state.turn)?;
        state
            .summaries
            .iter()
            .filter(|e| e.turn == state.turn && stage_of(e) == stage_of(last))
            .collect()
    };
    let count = |status: SummaryStatus| scope.iter().filter(|e| e.status == status).count();
    let (failed, exited) = (count(SummaryStatus::Failed), count(SummaryStatus::Exited));
    if !running && failed == 0 && exited == 0 {
        return None;
    }
    Some(json!({
        "running": count(SummaryStatus::Running),
        "finished": count(SummaryStatus::Finished),
        "exited": exited,
        "failed": failed,
        "cancelled": count(SummaryStatus::Cancelled),
    }))
}

#[cfg(test)]
#[path = "subagents_retention.test.rs"]
mod tests;
