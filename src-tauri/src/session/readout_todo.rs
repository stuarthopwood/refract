// Todo-phase parsing and the "Up next" transform, split out of `readout.rs` to stay under the cap.
use serde_json::{json, Value};

/// Matches the renderer's `TodoTaskStatus` union. Unknown statuses normalise to `pending`
/// so the glyph table never meets an unseen value.
const KNOWN_STATUSES: [&str; 5] = [
    "pending",
    "in_progress",
    "completed",
    "blocked",
    "abandoned",
];

#[derive(Debug, Clone)]
pub(super) struct TodoTaskState {
    /// Shown in the pinned panel.
    pub(super) content: String,
    pub(super) status: String,
    /// Set only on `"blocked"` tasks.
    pub(super) blocker: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct TodoPhaseState {
    /// Phase name for the **Up next** list. Live state only.
    pub(super) name: String,
    pub(super) tasks: Vec<TodoTaskState>,
}

/// Parses phases, names, and task content and blockers from the wire value.
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
                                    .filter(|s| KNOWN_STATUSES.contains(s))
                                    .unwrap_or("pending")
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

/// Full `todoTree` for the pinned panel. `null` when there is no list. An empty array stays
/// empty so the renderer applies one "no plan" rule.
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

/// Pending phases with their outstanding task counts. `null` when none are pending.
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
