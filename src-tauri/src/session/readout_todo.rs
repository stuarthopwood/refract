// Named Todo-phase parsing and the "Up next" readout transform (issue #941), split out of the
// parent `readout` module (#806 file-size discipline: `readout.rs` sits at its own 600-line
// cap with no headroom for a brand-new field) -- mirrors `subagents.rs`'s own
// `subagents_progress` sibling split (issue #784's "if you truly need a core change, keep it to
// one line" pattern, applied to a sibling module instead).
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(super) struct TodoTaskState {
    pub(super) status: String,
}

#[derive(Debug, Clone)]
pub(super) struct TodoPhaseState {
    /// The phase's own name (OMP `todoPhases[].name`), shown by the Subagent chain's **Up
    /// next** list (issue #941): "<name> · n tasks" for every phase with at least one task
    /// not yet `completed`/`abandoned`. Never shown for a reopened Conversation (live state
    /// only, `state_synced` already gates that the same way `contextUsage` does).
    pub(super) name: String,
    pub(super) tasks: Vec<TodoTaskState>,
}

/// Port of `readout.rs`'s own original `parse_todo_phases`, now also reading each phase's own
/// `name` (issue #941).
pub(super) fn parse_todo_phases(value: &Value) -> Option<Vec<TodoPhaseState>> {
    let phases = value.as_array()?;
    Some(
        phases
            .iter()
            .map(|phase| TodoPhaseState {
                name: phase
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                tasks: phase
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map(|tasks| {
                        tasks
                            .iter()
                            .map(|task| TodoTaskState {
                                status: task
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
    )
}

/// Issue #941 "Up next": the agent's own pending Todo phases (name and outstanding task count),
/// shown after a turn's Stages; `null` when there is no todo list, or every phase is fully
/// `completed`/`abandoned`. A brand-new, Rust-only field (Electron's own frozen `readout.ts`
/// never named phases either -- `contract_replay.rs`'s own `scrub_known_divergences` drops it).
pub(super) fn compute_up_next(phases: Option<&Vec<TodoPhaseState>>) -> Value {
    let up_next = phases.map(|phases| {
        phases
            .iter()
            .filter_map(|p| {
                let pending_count = p
                    .tasks
                    .iter()
                    .filter(|t| t.status != "completed" && t.status != "abandoned")
                    .count();
                if pending_count == 0 {
                    return None;
                }
                Some(json!({ "name": p.name, "pendingCount": pending_count }))
            })
            .collect::<Vec<_>>()
    });
    match up_next {
        Some(v) if !v.is_empty() => Value::Array(v),
        _ => Value::Null,
    }
}
