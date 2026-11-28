// Recorded-frame sequences for the background `task` lifecycle (#1623).

use serde_json::{json, Value};

use super::super::{SubagentStatus, TranscriptItem, TranscriptState};

fn subagent_states(state: &TranscriptState) -> Vec<(SubagentStatus, Option<i64>, Option<String>)> {
    state
        .items()
        .iter()
        .filter_map(|item| match item.as_ref() {
            TranscriptItem::Subagent {
                status,
                duration_ms,
                job_id,
                ..
            } => Some((*status, *duration_ms, job_id.clone())),
            _ => None,
        })
        .collect()
}

fn task_start() -> Value {
    json!({
        "type": "tool_execution_start", "toolCallId": "call-1", "toolName": "task",
        "args": { "tasks": [{ "name": "ImplA", "task": "do a" }, { "name": "ImplB", "task": "do b" }] }
    })
}

fn task_end(statuses: &[&str]) -> Value {
    let progress: Vec<Value> = statuses
        .iter()
        .enumerate()
        .map(|(i, s)| json!({ "id": format!("job-{i}"), "status": s }))
        .collect();
    json!({
        "type": "tool_execution_end", "toolCallId": "call-1", "toolName": "task",
        "isError": false, "result": { "content": [], "details": { "progress": progress } }
    })
}

fn wait_end(job_status: &str) -> Value {
    json!({
        "type": "tool_execution_end", "toolCallId": "wait-1", "toolName": "wait",
        "isError": false,
        "result": { "content": [], "details": { "jobs": [
            { "jobId": "job-0", "label": "ImplA", "status": job_status, "durationMs": 4200, "resultText": "ok" }
        ] } }
    })
}

#[test]
fn async_task_end_leaves_running_agents_running() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    state.apply_frame(&task_end(&["running", "pending"]), false);
    let rows = subagent_states(&state);
    assert_eq!(rows[0].0, SubagentStatus::Running);
    assert_eq!(rows[1].0, SubagentStatus::Running);
    assert_eq!(rows[0].2.as_deref(), Some("job-0"));
}

#[test]
fn wait_end_settles_the_agent_with_a_real_duration() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    state.apply_frame(&task_end(&["running", "running"]), false);
    state.apply_frame(&wait_end("completed"), false);
    let rows = subagent_states(&state);
    assert_eq!(
        rows[0],
        (SubagentStatus::Done, Some(4200), Some("job-0".into()))
    );
    assert_eq!(rows[1].0, SubagentStatus::Running);
}

#[test]
fn lifecycle_settle_after_async_end_sets_duration() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    state.apply_frame(&task_end(&["running", "running"]), false);
    state.settle_subagent("call-1", 1, super::ProgressOutcome::Finished, Some(900));
    let rows = subagent_states(&state);
    assert_eq!(rows[1].0, SubagentStatus::Done);
    assert_eq!(rows[1].1, Some(900));
}

#[test]
fn settled_progress_entry_settles_on_the_task_end() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    state.apply_frame(&task_end(&["completed", "failed"]), false);
    let rows = subagent_states(&state);
    assert_eq!(rows[0].0, SubagentStatus::Done);
    assert_eq!(rows[1].0, SubagentStatus::Error);
}

#[test]
fn sync_task_end_without_progress_settles_done() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    let end = json!({
        "type": "tool_execution_end", "toolCallId": "call-1", "toolName": "task",
        "isError": false, "result": { "content": [], "details": {} }
    });
    state.apply_frame(&end, false);
    assert!(subagent_states(&state)
        .iter()
        .all(|r| r.0 == SubagentStatus::Done));
}

fn history(with_wait: bool) -> Vec<Value> {
    let mut messages = vec![
        json!({ "role": "assistant", "content": [{
            "type": "toolCall", "id": "call-1", "name": "task",
            "arguments": { "tasks": [{ "name": "ImplA", "task": "do a" }] }
        }] }),
        json!({ "role": "toolResult", "toolCallId": "call-1", "toolName": "task",
            "isError": false, "content": [],
            "details": { "progress": [{ "id": "job-0", "status": "running" }] } }),
    ];
    if with_wait {
        messages.push(
            json!({ "role": "toolResult", "toolCallId": "wait-1", "toolName": "wait",
            "isError": false, "content": [],
            "details": { "jobs": [{ "jobId": "job-0", "label": "ImplA", "status": "completed",
                "durationMs": 700, "resultText": "ok" }] } }),
        );
    }
    messages
}

#[test]
fn history_replay_applies_later_wait_results() {
    let mut state = TranscriptState::from_history(&history(true));
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    assert_eq!(
        subagent_states(&state)[0],
        (SubagentStatus::Done, Some(700), Some("job-0".into()))
    );
}

#[test]
fn history_replay_never_leaves_an_unsignalled_agent_running() {
    let mut state = TranscriptState::from_history(&history(false));
    state.set_terminated_unexpectedly(true);
    state.settle_interrupted_tool_rows();
    assert_eq!(subagent_states(&state)[0].0, SubagentStatus::Done);
}

/// The recorded shape of a real background spawn (OMP 18.22): one `pending` entry per agent, no `results`.
fn spawn_result_frame() -> Value {
    json!({
        "type": "tool_execution_end", "toolCallId": "call-1", "toolName": "task",
        "isError": false,
        "result": {
            "content": [{ "type": "text", "text": "Spawned 2 background agents using scout, sonic." }],
            "details": { "results": [], "progress": [
                { "index": 0, "id": "ScoutA", "agent": "scout", "status": "pending", "task": "scan a" },
                { "index": 1, "id": "SonicB", "agent": "sonic", "status": "pending", "task": "scan b" }
            ] }
        }
    })
}

fn subagent_names(state: &TranscriptState) -> Vec<(String, String)> {
    state
        .items()
        .iter()
        .filter_map(|item| match item.as_ref() {
            TranscriptItem::Subagent { name, task, .. } => Some((name.clone(), task.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn spawn_result_alone_builds_running_agents_live() {
    let mut state = TranscriptState::new();
    state.apply_frame(&spawn_result_frame(), false);
    let rows = subagent_states(&state);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0],
        (SubagentStatus::Running, None, Some("ScoutA".into()))
    );
    assert_eq!(rows[1].0, SubagentStatus::Running);
    assert_eq!(
        subagent_names(&state)[1],
        ("SonicB".to_string(), "scan b".to_string())
    );
    assert!(state
        .items()
        .iter()
        .all(|item| !matches!(item.as_ref(), TranscriptItem::Tool { .. })));
}

#[test]
fn spawn_result_in_history_builds_agents_without_a_call_echo() {
    let messages = vec![json!({
        "role": "toolResult", "toolCallId": "call-1", "toolName": "task", "isError": false,
        "content": [], "details": spawn_result_frame()["result"]["details"].clone()
    })];
    let state = TranscriptState::from_history(&messages);
    let rows = subagent_states(&state);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].2.as_deref(), Some("ScoutA"));
}

#[test]
fn spawn_result_does_not_duplicate_items_from_the_start_frame() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);
    state.apply_frame(&spawn_result_frame(), false);
    assert_eq!(subagent_states(&state).len(), 2);
    assert_eq!(subagent_names(&state)[0].0, "ImplA");
}

#[test]
fn settled_result_without_items_still_renders_a_tool_row() {
    let mut state = TranscriptState::new();
    let end = json!({
        "type": "tool_execution_end", "toolCallId": "call-1", "toolName": "task",
        "isError": false,
        "result": { "content": [], "details": { "progress": [{ "id": "a", "status": "completed" }] } }
    });
    state.apply_frame(&end, false);
    assert!(subagent_states(&state).is_empty());
}

fn task_end_frame(is_error: bool, progress: Value) -> Value {
    json!({
        "type": "tool_execution_end", "toolCallId": "call-1", "toolName": "task",
        "isError": is_error,
        "result": { "content": [], "details": { "progress": progress } }
    })
}

#[test]
fn failed_spawn_result_builds_no_agents() {
    let mut state = TranscriptState::new();
    let progress = spawn_result_frame()["result"]["details"]["progress"].clone();
    state.apply_frame(&task_end_frame(true, progress), false);
    assert!(subagent_states(&state).is_empty());
}

#[test]
fn spawn_result_with_an_entry_missing_its_id_builds_no_agents() {
    let mut state = TranscriptState::new();
    let progress = json!([
        { "id": "ScoutA", "status": "pending", "task": "scan a" },
        { "status": "pending", "task": "scan b" }
    ]);
    state.apply_frame(&task_end_frame(false, progress), false);
    assert!(subagent_states(&state).is_empty());
}

#[test]
fn spawn_result_with_mixed_statuses_keeps_each_agents_own_status() {
    let mut state = TranscriptState::new();
    let progress = json!([
        { "id": "ScoutA", "status": "running", "task": "scan a" },
        { "id": "SonicB", "status": "completed", "task": "scan b" }
    ]);
    state.apply_frame(&task_end_frame(false, progress), false);
    let rows = subagent_states(&state);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, SubagentStatus::Running);
    assert_eq!(rows[1].0, SubagentStatus::Done);
}
