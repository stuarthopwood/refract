use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::super::test_support::agent_fixture;
use super::*;

fn rows(progress: &Value) -> Vec<Value> {
    let mut state = State::default();
    apply_subagent_progress_in_place(&mut state, "sub-1", progress)
}

#[test]
fn a_tool_entry_intent_is_its_own_row_field_and_not_the_target() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "read", "args": "src/a.rs", "intent": "Reading the file: for context", "endMs": 5 }]
    }));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["intent"], "Reading the file: for context");
    assert_eq!(rows[0]["target"], "src/a.rs");
}

#[test]
fn a_tool_entry_without_args_targets_the_tool_name_and_keeps_its_intent() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "bash", "intent": "Run the build", "endMs": 6 }]
    }));
    assert_eq!(rows[0]["target"], "bash");
    assert_eq!(rows[0]["intent"], "Run the build");
}

#[test]
fn a_tool_entry_without_an_intent_has_no_intent_field() {
    let rows = rows(&json!({
        "recentTools": [{ "tool": "bash", "args": "ls", "endMs": 7 }]
    }));
    assert!(rows[0].get("intent").is_none());
    assert_eq!(rows[0]["target"], "ls");
}

fn entry() -> SummaryEntry {
    SummaryEntry {
        id: "t1:a".into(),
        tool_call_id: "t1".into(),
        spec_index: 0,
        name_or_task: "a".into(),
        name: None,
        task_summary: None,
        status: SummaryStatus::Running,
        started_at: 1,
        duration_ms: None,
        background: false,
        role: None,
        overall_goal: None,
        files_touched: Vec::new(),
        recent_steps: Vec::new(),
        stage_key: "m1".into(),
        turn: 0,
    }
}

fn beat(tools: Value) -> Value {
    json!({ "recentTools": tools })
}

/// A visible agent holding one running entry `t1:a`, with every `subagents:update` payload recorded.
async fn watched_agent() -> (Arc<SessionAgent>, Arc<Mutex<Vec<Value>>>) {
    let fx = agent_fixture(true).await;
    let emits = Arc::new(Mutex::new(Vec::new()));
    let sink = emits.clone();
    fx.agent
        .events()
        .set_subagents_probe(move |value| sink.lock().unwrap().push(value.clone()));
    fx.agent
        .with_subagents_state(|s| s.summaries.push(entry()))
        .await;
    (fx.agent, emits)
}

fn heartbeat_frame(n: i64) -> Value {
    json!({
        "parentToolCallId": "t1",
        "index": 0,
        "progress": { "recentTools": [{ "tool": "bash", "args": format!("c{n}"), "endMs": n }] }
    })
}

/// Runs the clock to `ms` into the window; the paused clock moves only here, so no test waits in real time.
async fn advance_ms(ms: u64) {
    // Lets a freshly spawned timer task register its sleep before the clock moves.
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(ms)).await;
    // Lets the woken timer task run to its emit.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

async fn past_the_coalescing_window() {
    advance_ms(SUMMARIES_COALESCE_MS).await;
}

#[tokio::test(start_paused = true)]
async fn many_heartbeats_inside_one_window_emit_once_with_the_latest_steps() {
    let (agent, emits) = watched_agent().await;

    for n in 0..20 {
        apply_subagent_frame(&agent, "subagent_progress", &heartbeat_frame(n)).await;
    }
    advance_ms(SUMMARIES_COALESCE_MS - 1).await;
    assert!(
        emits.lock().unwrap().is_empty(),
        "nothing emits before the window closes"
    );
    advance_ms(1).await;

    let emits = emits.lock().unwrap();
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0][0]["recentSteps"][0]["target"], "c19");
}

#[tokio::test(start_paused = true)]
async fn a_settle_emits_at_once_and_the_pending_window_adds_nothing() {
    let (agent, emits) = watched_agent().await;
    apply_subagent_frame(&agent, "subagent_progress", &heartbeat_frame(1)).await;

    let settle = json!({ "parentToolCallId": "t1", "index": 0, "status": "completed" });
    apply_subagent_frame(&agent, "subagent_lifecycle", &settle).await;
    {
        let now = emits.lock().unwrap();
        assert_eq!(now.len(), 1, "the settle does not wait for the window");
        assert_eq!(now[0][0]["status"], "finished");
        assert_eq!(now[0][0]["recentSteps"][0]["target"], "c1");
    }
    past_the_coalescing_window().await;

    assert_eq!(emits.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn heartbeats_in_a_later_window_emit_again() {
    let (agent, emits) = watched_agent().await;

    apply_subagent_frame(&agent, "subagent_progress", &heartbeat_frame(1)).await;
    past_the_coalescing_window().await;
    apply_subagent_frame(&agent, "subagent_progress", &heartbeat_frame(2)).await;
    past_the_coalescing_window().await;

    assert_eq!(emits.lock().unwrap().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_hidden_session_emits_nothing_for_heartbeats_or_a_settle() {
    let fx = agent_fixture(false).await;
    let emits = Arc::new(Mutex::new(Vec::new()));
    let sink = emits.clone();
    fx.agent
        .events()
        .set_subagents_probe(move |value| sink.lock().unwrap().push(value.clone()));
    fx.agent
        .with_subagents_state(|s| s.summaries.push(entry()))
        .await;

    apply_subagent_frame(&fx.agent, "subagent_progress", &heartbeat_frame(1)).await;
    past_the_coalescing_window().await;
    let settle = json!({ "parentToolCallId": "t1", "index": 0, "status": "completed" });
    apply_subagent_frame(&fx.agent, "subagent_lifecycle", &settle).await;
    past_the_coalescing_window().await;

    assert!(emits.lock().unwrap().is_empty());
    let kept = fx.agent.with_subagents_state(|s| s.summaries.len()).await;
    assert_eq!(kept, 1, "the hidden Session still tracks its entry");
}

/// A fixture agent made `Idle` (an unlaunched one is `Stopped`, which the aggregate skips), with
/// the push that status change queued already flushed.
async fn idle_fixture() -> super::super::test_support::AgentFixture {
    let fx = agent_fixture(false).await;
    fx.agent
        .set_status(crate::session::SessionStatus::Idle, None, None)
        .await;
    past_the_coalescing_window().await;
    fx
}

fn watch_agents(fx: &super::super::test_support::AgentFixture) -> Arc<Mutex<Vec<Value>>> {
    let emits = Arc::new(Mutex::new(Vec::new()));
    let sink = emits.clone();
    fx.agent
        .events()
        .set_agents_probe(move |groups| sink.lock().unwrap().push(groups.clone()));
    emits
}

#[tokio::test(start_paused = true)]
async fn a_hidden_session_still_reaches_the_aggregate_once_per_window() {
    let fx = idle_fixture().await;
    let emits = watch_agents(&fx);
    fx.agent
        .with_subagents_state(|s| s.summaries.push(entry()))
        .await;

    for n in 0..20 {
        apply_subagent_frame(&fx.agent, "subagent_progress", &heartbeat_frame(n)).await;
    }
    past_the_coalescing_window().await;

    let emits = emits.lock().unwrap();
    assert_eq!(emits.len(), 1, "one coalesced push for the whole burst");
    assert_eq!(emits[0][0]["sessionId"], fx.id.as_str());
    assert_eq!(emits[0][0]["name"], "test");
    assert_eq!(emits[0][0]["repositoryName"], "repo");
    assert_eq!(emits[0][0]["status"], "idle");
    assert_eq!(
        emits[0][0]["subagents"][0]["recentSteps"][0]["target"],
        "c19"
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_with_nothing_to_show_has_no_group() {
    let fx = agent_fixture(false).await;
    assert_eq!(fx.manager.agents_snapshot().await, json!([]));
}

#[tokio::test(start_paused = true)]
async fn deleting_a_session_pushes_the_aggregate_without_its_group() {
    let fx = idle_fixture().await;
    let emits = watch_agents(&fx);
    fx.agent
        .with_subagents_state(|s| s.summaries.push(entry()))
        .await;
    assert_eq!(
        fx.manager.agents_snapshot().await.as_array().unwrap().len(),
        1
    );

    fx.manager.remove_agent(&fx.id);
    past_the_coalescing_window().await;

    assert_eq!(emits.lock().unwrap().last(), Some(&json!([])));
}

#[tokio::test(start_paused = true)]
async fn a_stopped_session_drops_out_of_the_aggregate() {
    let fx = idle_fixture().await;
    fx.agent
        .with_subagents_state(|s| s.summaries.push(entry()))
        .await;
    assert_eq!(
        fx.manager.agents_snapshot().await.as_array().unwrap().len(),
        1
    );
    fx.agent.shutdown().await;

    assert_eq!(fx.manager.agents_snapshot().await, json!([]));
}

#[test]
fn serialisation_omits_absent_synthesis_and_progress_fields() {
    let value = summaries_to_value(&[entry()]);
    let obj = value[0].as_object().expect("object");
    for key in ["role", "overallGoal", "filesTouched", "recentSteps"] {
        assert!(!obj.contains_key(key), "{key} must be omitted");
    }
}

#[test]
fn serialisation_emits_present_fields_in_camel_case_without_nulls() {
    let mut e = entry();
    e.role = Some("Reviewer".into());
    e.overall_goal = Some("Ship it".into());
    accumulate_heartbeat(
        &mut e,
        &beat(json!([{ "tool": "write", "args": "a.rs", "endMs": 9 }])),
    );
    let value = summaries_to_value(&[e]);
    assert_eq!(value[0]["role"], "Reviewer");
    assert_eq!(value[0]["overallGoal"], "Ship it");
    assert_eq!(value[0]["filesTouched"], json!(["a.rs"]));
    assert_eq!(
        value[0]["recentSteps"],
        json!([{ "tool": "write", "target": "a.rs", "endMs": 9 }])
    );
}

#[test]
fn serialisation_carries_the_stage_key() {
    assert_eq!(summaries_to_value(&[entry()])[0]["stageKey"], "m1");
}
