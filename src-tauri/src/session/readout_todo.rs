// Named Todo-phase parsing and the "Up next" readout transform (issue #941), split out of the
// parent `readout` module (#806 file-size discipline: `readout.rs` sits at its own 600-line
// cap with no headroom for a brand-new field) -- mirrors `subagents.rs`'s own
// `subagents_progress` sibling split (issue #784's "if you truly need a core change, keep it to
// one line" pattern, applied to a sibling module instead).
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(super) struct TodoTaskState {
    /// Issue #700/#701 slice (a): retained (FINDINGS item 62) so the pinned panel can show each
    /// task's own text, not just its status -- `compute_up_next` below never needed it (Up next
    /// shows only a phase's own name and outstanding count).
    pub(super) content: String,
    pub(super) status: String,
    /// Present only on a `"blocked"` task (FINDINGS item 62: live-probed, never `null`/empty on
    /// any other status) -- the pinned panel's own "Blocked: <blocker>" second line.
    pub(super) blocker: Option<String>,
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
/// `name` (issue #941) plus each task's own `content` and `blocker` (issue #700/#701 slice a,
/// FINDINGS item 62).
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
                                content: task
                                    .get("content")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                status: task
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                blocker: task
                                    .get("blocker")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
    )
}

/// Issue #700/#701 slice (a): the pinned panel's own wire field, `todoTree` -- the full retained
/// tree (every phase, every task's own `content`/`status`/`blocker`), never the filtered "only
/// pending" shape `compute_up_next` below builds for Up next. `null` when there is no todo list
/// at all (`phases` is `None`); an empty array is left AS an empty array (never collapsed to
/// `null`) so the renderer's own "no plan" check (every phase has zero tasks) stays one single
/// rule shared with a genuinely absent list, rather than this file inventing a second one.
pub(super) fn build_todo_tree(phases: Option<&Vec<TodoPhaseState>>) -> Value {
    match phases {
        None => Value::Null,
        Some(phases) => json!(phases
            .iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "tasks": p.tasks.iter().map(|t| {
                        let mut task = json!({ "content": t.content, "status": t.status });
                        if let Some(blocker) = &t.blocker {
                            task["blocker"] = json!(blocker);
                        }
                        task
                    }).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>()),
    }
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
