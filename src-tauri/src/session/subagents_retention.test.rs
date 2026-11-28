use std::sync::{Arc, Mutex};

use serde_json::json;

use super::super::test_support::agent_fixture;
use super::*;

fn entry(id: &str, stage: &str, turn: u32, status: SummaryStatus) -> SummaryEntry {
    SummaryEntry {
        id: id.into(),
        tool_call_id: format!("call-{stage}"),
        stage_key: stage.into(),
        turn,
        spec_index: 0,
        name_or_task: id.into(),
        name: None,
        task_summary: None,
        status,
        started_at: 1,
        duration_ms: None,
        background: false,
        role: None,
        overall_goal: None,
        card_summary: None,
        files_touched: Vec::new(),
        recent_steps: Vec::new(),
    }
}

/// Adds the entry with a stream holding one real row, as a live agent would have.
fn add(state: &mut State, entry: SummaryEntry) {
    state.streams.insert(
        entry.id.clone(),
        vec![json!({ "kind": "text", "id": "row-1" })],
    );
    state.stream_ids.insert(entry.id.clone(), HashSet::new());
    state.summaries.push(entry);
}

fn ids(state: &State) -> Vec<&str> {
    state.summaries.iter().map(|e| e.id.as_str()).collect()
}

/// A visible agent over `entries`, with every `subagents:update` payload recorded.
async fn watched(entries: Vec<SummaryEntry>) -> (Arc<SessionAgent>, Arc<Mutex<Vec<Value>>>) {
    let fx = agent_fixture(true).await;
    let emits = Arc::new(Mutex::new(Vec::new()));
    let sink = emits.clone();
    fx.agent
        .events()
        .set_subagents_probe(move |value| sink.lock().unwrap().push(value.clone()));
    fx.agent
        .with_subagents_state(|s| entries.into_iter().for_each(|e| add(s, e)))
        .await;
    (fx.agent, emits)
}

#[test]
fn an_assistant_message_start_records_the_stage_key_and_a_user_message_does_not() {
    let mut state = State::default();
    note_message_start(
        &mut state,
        &json!({ "messageId": "m1", "message": { "role": "assistant" } }),
    );
    note_message_start(
        &mut state,
        &json!({ "messageId": "u1", "message": { "role": "user" } }),
    );
    assert_eq!(state.current_message_id, "m1");
}

#[test]
fn a_new_agent_takes_the_current_message_id_and_turn() {
    let state = State {
        current_message_id: "m7".into(),
        turn: 3,
        ..State::default()
    };
    let mut e = entry("a", "", 0, SummaryStatus::Running);
    stamp_new_entry(&state, &mut e);
    assert_eq!((e.stage_key.as_str(), e.turn), ("m7", 3));
}

#[test]
fn without_an_assistant_message_the_call_id_stands_in_as_the_stage() {
    let e = entry("a", "", 0, SummaryStatus::Running);
    assert_eq!(stage_of(&e), "call-");
}

#[tokio::test]
async fn a_settled_stage_leaves_memory_and_the_panel_at_the_next_turn() {
    let (agent, emits) = watched(vec![
        entry("a", "m1", 0, SummaryStatus::Finished),
        entry("b", "m1", 0, SummaryStatus::Failed),
    ])
    .await;
    agent
        .with_subagents_state(|s| s.visible_id = Some("a".into()))
        .await;

    prune_for_new_turn(&agent).await;

    agent
        .with_subagents_state(|s| {
            assert!(s.summaries.is_empty());
            assert!(s.streams.is_empty() && s.stream_ids.is_empty());
            assert_eq!(
                s.visible_id, None,
                "a removed visible agent stops forwarding"
            );
            assert_eq!(s.turn, 1);
        })
        .await;
    assert_eq!(emits.lock().unwrap().last(), Some(&json!([])));
}

#[tokio::test]
async fn a_stage_with_a_running_agent_stays_whole() {
    let (agent, _) = watched(vec![
        entry("done", "m1", 0, SummaryStatus::Finished),
        entry("busy", "m1", 0, SummaryStatus::Running),
        entry("old", "m0", 0, SummaryStatus::Cancelled),
    ])
    .await;

    prune_for_new_turn(&agent).await;

    let kept = agent.with_subagents_state(|s| ids(s).join(",")).await;
    assert_eq!(kept, "done,busy");
}

#[tokio::test]
async fn a_background_stage_survives_a_turn_boundary_then_follows_the_normal_rule() {
    let (agent, _) = watched(vec![
        entry("fast", "bg", 0, SummaryStatus::Finished),
        entry("slow", "bg", 0, SummaryStatus::Running),
    ])
    .await;

    prune_for_new_turn(&agent).await;
    let after_first = agent.with_subagents_state(|s| ids(s).join(",")).await;
    assert_eq!(after_first, "fast,slow", "kept whole across the boundary");

    agent
        .with_subagents_state(|s| s.summaries[1].status = SummaryStatus::Finished)
        .await;
    prune_for_new_turn(&agent).await;
    let after_second = agent.with_subagents_state(|s| s.summaries.len()).await;
    assert_eq!(after_second, 0, "all settled, so the next turn removes it");
}

#[tokio::test]
async fn a_prune_that_removes_nothing_emits_nothing() {
    let (agent, emits) = watched(vec![entry("a", "m1", 0, SummaryStatus::Running)]).await;

    prune_for_new_turn(&agent).await;

    assert!(emits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reattach_drops_running_agents_and_agents_with_no_output_at_once() {
    let (agent, emits) = watched(vec![
        entry("run", "m1", 0, SummaryStatus::Running),
        entry("gone", "m1", 0, SummaryStatus::Exited),
        entry("kept", "m1", 0, SummaryStatus::Failed),
    ])
    .await;
    agent
        .with_subagents_state(|s| {
            s.streams.insert(
                "gone".into(),
                vec![json!({ "kind": "notice", "id": format!("gone{NO_OUTPUT_NOTICE_SUFFIX}") })],
            );
        })
        .await;

    drop_unavailable(&agent).await;

    let left = agent
        .with_subagents_state(|s| (ids(s).join(","), s.streams.len()))
        .await;
    assert_eq!(left, ("kept".to_string(), 1));
    assert_eq!(
        emits.lock().unwrap().last().map(|v| v[0]["id"].clone()),
        Some(json!("kept"))
    );
}

#[test]
fn nothing_retained_hides_the_pill() {
    assert_eq!(count_value(&State::default()), None);
}

#[test]
fn a_running_agent_counts_the_whole_retained_list() {
    let mut state = State {
        turn: 1,
        ..State::default()
    };
    add(&mut state, entry("old", "bg", 0, SummaryStatus::Running));
    add(&mut state, entry("fin", "m2", 1, SummaryStatus::Finished));
    add(&mut state, entry("bad", "m2", 1, SummaryStatus::Failed));
    assert_eq!(
        count_value(&state),
        Some(json!({ "running": 1, "finished": 1, "exited": 0, "failed": 1, "cancelled": 0 }))
    );
}

#[test]
fn a_failure_in_the_last_stage_shows_until_the_next_turn_starts() {
    let mut state = State::default();
    add(&mut state, entry("ok", "m1", 0, SummaryStatus::Finished));
    add(&mut state, entry("bad", "m1", 0, SummaryStatus::Failed));
    assert_eq!(
        count_value(&state),
        Some(json!({ "running": 0, "finished": 1, "exited": 0, "failed": 1, "cancelled": 0 }))
    );
    state.turn = 1;
    assert_eq!(count_value(&state), None);
}

#[test]
fn an_exited_agent_in_the_last_stage_shows() {
    let mut state = State::default();
    add(&mut state, entry("gone", "m1", 0, SummaryStatus::Exited));
    assert_eq!(count_value(&state).unwrap()["exited"], 1);
}

#[test]
fn only_the_last_stage_decides_the_failure_pill() {
    let mut state = State::default();
    add(&mut state, entry("bad", "m1", 0, SummaryStatus::Failed));
    add(&mut state, entry("ok", "m2", 0, SummaryStatus::Finished));
    assert_eq!(count_value(&state), None);
}

#[test]
fn settled_agents_without_a_failure_hide_the_pill() {
    let mut state = State::default();
    add(&mut state, entry("ok", "m1", 0, SummaryStatus::Finished));
    add(
        &mut state,
        entry("stopped", "m1", 0, SummaryStatus::Cancelled),
    );
    assert_eq!(count_value(&state), None);
}

#[test]
fn an_agent_with_no_stream_at_all_lacks_output() {
    assert!(lacks_output(&State::default(), "never-seen"));
}

#[tokio::test]
async fn reattach_stops_forwarding_a_visible_agent_it_drops() {
    let (agent, _) = watched(vec![
        entry("gone", "m1", 0, SummaryStatus::Running),
        entry("kept", "m1", 0, SummaryStatus::Failed),
    ])
    .await;
    agent
        .with_subagents_state(|s| {
            s.visible_id = Some("gone".into());
            s.pending_patch_ops.push(json!({ "op": "upsert" }));
        })
        .await;

    drop_unavailable(&agent).await;

    agent
        .with_subagents_state(|s| {
            assert_eq!(s.visible_id, None);
            assert!(s.pending_patch_ops.is_empty());
        })
        .await;
}

#[tokio::test]
async fn reattach_keeps_a_visible_agent_it_retains() {
    let (agent, _) = watched(vec![entry("kept", "m1", 0, SummaryStatus::Failed)]).await;
    agent
        .with_subagents_state(|s| s.visible_id = Some("kept".into()))
        .await;

    drop_unavailable(&agent).await;

    let visible = agent.with_subagents_state(|s| s.visible_id.clone()).await;
    assert_eq!(visible.as_deref(), Some("kept"));
}

#[tokio::test]
async fn agents_without_a_stage_key_are_pruned_by_their_call_id() {
    let mut busy = entry("busy", "", 0, SummaryStatus::Running);
    busy.tool_call_id = "c1".into();
    let mut sibling = entry("sibling", "", 0, SummaryStatus::Finished);
    sibling.tool_call_id = "c1".into();
    let mut other = entry("other", "", 0, SummaryStatus::Finished);
    other.tool_call_id = "c2".into();
    let (agent, _) = watched(vec![busy, sibling, other]).await;

    prune_for_new_turn(&agent).await;

    let kept = agent.with_subagents_state(|s| ids(s).join(",")).await;
    assert_eq!(kept, "busy,sibling");
}

#[tokio::test]
async fn retained_agents_keep_their_streams_through_a_prune() {
    let (agent, _) = watched(vec![
        entry("busy", "m1", 0, SummaryStatus::Running),
        entry("old", "m0", 0, SummaryStatus::Finished),
    ])
    .await;

    prune_for_new_turn(&agent).await;

    agent
        .with_subagents_state(|s| {
            assert_eq!(s.streams.keys().collect::<Vec<_>>(), ["busy"]);
            assert_eq!(s.stream_ids.keys().collect::<Vec<_>>(), ["busy"]);
            assert_eq!(
                s.streams["busy"],
                vec![json!({ "kind": "text", "id": "row-1" })]
            );
        })
        .await;
}

fn assistant_start(message_id: &str) -> Value {
    json!({
        "type": "message_start",
        "messageId": message_id,
        "message": { "role": "assistant", "content": [], "timestamp": 1 },
    })
}

fn task_start(call_id: &str, names: &[&str]) -> Value {
    let tasks: Vec<Value> = names
        .iter()
        .map(|name| json!({ "name": name, "task": "work" }))
        .collect();
    json!({
        "type": "tool_execution_start",
        "toolName": "task",
        "toolCallId": call_id,
        "args": { "tasks": tasks },
    })
}

fn task_progress(call_id: &str, agent_id: &str, status: &str) -> Value {
    json!({
        "type": "tool_execution_update",
        "toolName": "task",
        "toolCallId": call_id,
        "partialResult": { "details": { "progress": [{ "id": agent_id, "status": status }] } },
    })
}

#[tokio::test]
async fn frames_keep_a_running_stage_whole_and_drop_the_settled_one_at_the_next_turn() {
    let fx = agent_fixture(true).await;
    let agent = &fx.agent;
    // Otherwise the task-start hook would run the real `tiny` executor.
    super::super::discard_synthesis_cache(agent).await;

    agent.handle_frame(json!({ "type": "agent_start" })).await;
    agent.handle_frame(assistant_start("m1")).await;
    agent.handle_frame(task_start("call-a", &["a"])).await;
    agent
        .handle_frame(task_progress("call-a", "a", "completed"))
        .await;
    agent.handle_frame(assistant_start("m2")).await;
    agent
        .handle_frame(task_start("call-b", &["b1", "b2", "b3", "b4"]))
        .await;

    let running = |count: Option<Value>| count.unwrap()["running"].clone();
    assert_eq!(running(subagent_count(agent).await), json!(4));
    let before = agent.with_subagents_state(|s| ids(s).join(",")).await;
    assert_eq!(before, "call-a:a,call-b:b1,call-b:b2,call-b:b3,call-b:b4");

    agent.handle_frame(json!({ "type": "agent_start" })).await;

    let after = agent
        .with_subagents_state(|s| (ids(s).join(","), s.streams.len()))
        .await;
    assert_eq!(after.0, "call-b:b1,call-b:b2,call-b:b3,call-b:b4");
    assert_eq!(after.1, 4);
    assert_eq!(running(subagent_count(agent).await), json!(4));
}

#[tokio::test]
async fn a_conversation_reset_clears_the_current_message_id() {
    let fx = agent_fixture(true).await;
    fx.agent.handle_frame(assistant_start("m1")).await;
    let noted = fx
        .agent
        .with_subagents_state(|s| s.current_message_id.clone())
        .await;
    assert_eq!(noted, "m1");

    super::super::on_conversation_reset(&fx.agent).await;

    let cleared = fx
        .agent
        .with_subagents_state(|s| s.current_message_id.clone())
        .await;
    assert_eq!(cleared, "");
}
