// Hook tests: a fake executor counts every `omp` call, so no test ever reaches a real model.
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::omp::config::OmpConfigError;

type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>>;

const GOOD_REPLY: &str = r#"{"overallGoal": "Ship the card", "roles": ["Researcher", "Builder"]}"#;

/// Answers `omp config get modelRoles` from `roles` and every other call with `reply`, recording both.
struct FakeExec {
    roles: serde_json::Value,
    reply: StdMutex<String>,
    calls: StdMutex<Vec<Vec<String>>>,
    /// When set, a model call blocks until a permit is released, so a test controls how long calls overlap.
    gate: Option<Semaphore>,
    /// When set, a start card call (a brief with no result) blocks until a permit is released.
    start_gate: Option<Semaphore>,
    in_flight: AtomicUsize,
    peak_in_flight: AtomicUsize,
}

impl FakeExec {
    fn new(roles: serde_json::Value, reply: &str) -> Arc<Self> {
        Self::build(roles, reply, None, None)
    }

    fn gated(roles: serde_json::Value, reply: &str) -> Arc<Self> {
        Self::build(roles, reply, Some(Semaphore::new(0)), None)
    }

    fn start_gated(roles: serde_json::Value, reply: &str) -> Arc<Self> {
        Self::build(roles, reply, None, Some(Semaphore::new(0)))
    }

    fn build(
        roles: serde_json::Value,
        reply: &str,
        gate: Option<Semaphore>,
        start_gate: Option<Semaphore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            roles,
            reply: StdMutex::new(reply.to_string()),
            calls: StdMutex::new(Vec::new()),
            gate,
            start_gate,
            in_flight: AtomicUsize::new(0),
            peak_in_flight: AtomicUsize::new(0),
        })
    }

    /// Changes what every later model call answers, so a finish call can differ from the start call.
    fn set_reply(&self, reply: &str) {
        *self.reply.lock().unwrap() = reply.to_string();
    }

    /// Lets `n` blocked model calls finish.
    fn release(&self, n: usize) {
        self.gate.as_ref().expect("a gated executor").add_permits(n);
    }

    /// Lets `n` blocked start card calls finish.
    fn release_starts(&self, n: usize) {
        self.start_gate
            .as_ref()
            .expect("a start-gated executor")
            .add_permits(n);
    }

    fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    fn config_reads(&self) -> usize {
        self.count(|args| args.first().map(String::as_str) == Some("config"))
    }

    fn model_calls(&self) -> usize {
        self.count(|args| args.first().map(String::as_str) != Some("config"))
    }

    fn count(&self, keep: impl Fn(&[String]) -> bool) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|args| keep(args))
            .count()
    }
}

impl OmpExecutor for FakeExec {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        _strip_env_vars: &'a [&'a str],
    ) -> CallFuture<'a> {
        self.calls.lock().unwrap().push(args.to_vec());
        let is_config = args.first().map(String::as_str) == Some("config");
        Box::pin(async move {
            if is_config {
                return Ok(json!({ "key": "modelRoles", "value": self.roles, "type": "record", "description": "" })
                    .to_string());
            }
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_in_flight.fetch_max(now, Ordering::SeqCst);
            // Taken before any wait, so a call answers what was set when it began.
            let reply = self.reply.lock().unwrap().clone();
            if let Some(gate) = &self.start_gate {
                if is_start_card_prompt(args) {
                    gate.acquire()
                        .await
                        .expect("the gate is never closed")
                        .forget();
                }
            }
            if let Some(gate) = &self.gate {
                gate.acquire()
                    .await
                    .expect("the gate is never closed")
                    .forget();
            }
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(reply)
        })
    }
}

/// Whether the call's `@file` prompt holds an agent brief and no result: a start card summary.
fn is_start_card_prompt(args: &[String]) -> bool {
    let prompt = args
        .last()
        .and_then(|arg| arg.strip_prefix('@'))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    prompt.contains("<agent-brief-") && !prompt.contains("<agent-result-")
}

fn roles_with_tiny() -> serde_json::Value {
    json!({ "default": "anthropic/claude-big", "smol": "anthropic/claude-mid", "tiny": "anthropic/claude-small" })
}

struct Fixture {
    agent: Arc<SessionAgent>,
    exec: Arc<FakeExec>,
    id: String,
    dir: PathBuf,
    manager: Arc<crate::session::manager::SessionManager>,
}

/// A Session with Summarise agent cards off, so the group synthesis tests count only their own call.
async fn fixture(exec: Arc<FakeExec>) -> Fixture {
    let fx = fixture_with_cards(exec).await;
    set_summarise_agent_cards(&fx, false).await;
    fx
}

/// A Session with Summarise agent cards at its default, on.
async fn fixture_with_cards(exec: Arc<FakeExec>) -> Fixture {
    let base = super::super::test_support::agent_fixture(false).await;
    let injected = exec.clone();
    base.agent
        .with_subagents_state(|s| s.synthesis.exec = injected)
        .await;
    Fixture {
        agent: base.agent,
        exec,
        id: base.id,
        dir: base.dir,
        manager: base.manager,
    }
}

async fn set_summarise_agent_cards(fx: &Fixture, on: bool) {
    fx.manager
        .settings
        .lock()
        .await
        .set_summarise_agent_cards(on)
        .await
        .unwrap();
}

fn task_args() -> Value {
    json!({
        "context": "Shared context",
        "tasks": [
            { "name": "Alpha", "task": "Research the thing." },
            { "name": "Beta", "task": "Build the thing." }
        ]
    })
}

async fn summaries(agent: &SessionAgent) -> Vec<Value> {
    super::super::current_summaries_value(agent)
        .await
        .as_array()
        .cloned()
        .unwrap()
}

/// Polls until `done` holds for the live summaries; the labels land from a detached task.
async fn wait_for(agent: &SessionAgent, done: impl Fn(&[Value]) -> bool) {
    for _ in 0..500 {
        if done(&summaries(agent).await) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the summaries never reached the expected state");
}

/// Polls until `done` holds, and fails the test instead of hanging when it never does.
async fn poll_until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting until {what}");
}

/// Gives a detached task that must do nothing time to prove it did nothing.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

fn cache_dir(fx: &Fixture) -> PathBuf {
    session_cache_dir(&fx.dir, &fx.id).unwrap()
}

#[tokio::test]
async fn a_miss_calls_the_model_once_then_labels_the_cards_and_saves_the_cache() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), GOOD_REPLY)).await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    wait_for(&fx.agent, |s| s.iter().all(|e| e.get("role").is_some())).await;

    let cards = summaries(&fx.agent).await;
    assert_eq!(cards[0]["role"], "Researcher");
    assert_eq!(cards[1]["role"], "Builder");
    assert!(cards.iter().all(|c| c["overallGoal"] == "Ship the card"));
    assert_eq!(fx.exec.model_calls(), 1);
    let saved = SynthesisCache::load(&cache_dir(&fx));
    assert_eq!(
        saved.get("call-1").and_then(|s| s.overall_goal.as_deref()),
        Some("Ship the card")
    );
}

#[tokio::test]
async fn a_second_start_for_the_same_tool_call_makes_no_second_call() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), GOOD_REPLY)).await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    wait_for(&fx.agent, |s| s.iter().any(|e| e.get("role").is_some())).await;
    settle().await;

    assert_eq!(fx.exec.model_calls(), 1);
    assert_eq!(fx.exec.config_reads(), 1);
}

#[tokio::test]
async fn a_cache_hit_labels_the_cards_without_any_call() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), GOOD_REPLY)).await;
    SynthesisCache::load(&cache_dir(&fx))
        .insert(
            "call-1",
            Synthesis {
                overall_goal: Some("From disk".to_string()),
                roles: vec![None, Some("Cached builder".to_string())],
            },
        )
        .unwrap()
        .write()
        .unwrap();

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;

    let cards = summaries(&fx.agent).await;
    assert!(cards.iter().all(|c| c["overallGoal"] == "From disk"));
    assert!(cards[0].get("role").is_none());
    assert_eq!(cards[1]["role"], "Cached builder");
    settle().await;
    assert_eq!(fx.exec.model_calls(), 0);
    assert_eq!(fx.exec.config_reads(), 0);
}

#[tokio::test]
async fn an_unset_tiny_role_makes_no_model_call_and_leaves_the_cards_unlabelled() {
    let fx = fixture(FakeExec::new(
        json!({ "default": "anthropic/claude-big" }),
        GOOD_REPLY,
    ))
    .await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    poll_until("the roles were read", || fx.exec.config_reads() > 0).await;
    settle().await;

    assert_eq!(fx.exec.model_calls(), 0);
    let cards = summaries(&fx.agent).await;
    assert!(cards
        .iter()
        .all(|c| c.get("role").is_none() && c.get("overallGoal").is_none()));
    assert_eq!(SynthesisCache::load(&cache_dir(&fx)).get("call-1"), None);
}

#[tokio::test]
async fn a_second_task_call_with_tiny_unset_makes_no_omp_call_at_all() {
    let fx = fixture(FakeExec::new(
        json!({ "default": "anthropic/claude-big" }),
        GOOD_REPLY,
    ))
    .await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    poll_until("the roles were read", || fx.exec.config_reads() > 0).await;
    settle().await;
    super::super::handle_task_start(&fx.agent, "call-2", &task_args()).await;
    settle().await;

    assert_eq!(fx.exec.config_reads(), 1);
    assert_eq!(fx.exec.model_calls(), 0);
}

#[tokio::test]
async fn a_burst_of_task_calls_reads_the_roles_once_and_runs_two_model_calls_at_a_time() {
    let fx = fixture(FakeExec::gated(roles_with_tiny(), GOOD_REPLY)).await;

    for n in 0..5 {
        super::super::handle_task_start(&fx.agent, &format!("call-{n}"), &task_args()).await;
    }
    poll_until("two model calls are in flight", || fx.exec.in_flight() == 2).await;
    settle().await;
    assert_eq!(
        fx.exec.model_calls(),
        2,
        "a third call started past the cap"
    );

    fx.exec.release(5);
    poll_until("all five model calls ran", || fx.exec.model_calls() == 5).await;
    poll_until("every call finished", || fx.exec.in_flight() == 0).await;

    assert_eq!(fx.exec.config_reads(), 1);
    assert_eq!(fx.exec.peak_in_flight.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_unusable_reply_leaves_the_cards_unlabelled_and_is_not_retried() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), "no json here")).await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    poll_until("the model was called", || fx.exec.model_calls() > 0).await;
    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    settle().await;

    assert_eq!(fx.exec.model_calls(), 1);
    assert!(summaries(&fx.agent)
        .await
        .iter()
        .all(|c| c.get("role").is_none()));
    assert_eq!(SynthesisCache::load(&cache_dir(&fx)).get("call-1"), None);
}

#[tokio::test]
async fn each_tool_call_is_labelled_by_its_own_cache_entry() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), GOOD_REPLY)).await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    super::super::handle_task_start(&fx.agent, "call-2", &task_args()).await;
    wait_for(&fx.agent, |s| {
        s.len() == 4 && s.iter().all(|e| e.get("role").is_some())
    })
    .await;

    assert_eq!(fx.exec.model_calls(), 2);
    let saved = SynthesisCache::load(&cache_dir(&fx));
    assert!(saved.get("call-1").is_some() && saved.get("call-2").is_some());
}

#[tokio::test]
async fn a_delete_during_a_slow_synthesis_leaves_no_session_folder() {
    let fx = fixture(FakeExec::gated(roles_with_tiny(), GOOD_REPLY)).await;
    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    poll_until("the model call is in flight", || fx.exec.in_flight() == 1).await;

    super::super::discard_synthesis_cache(&fx.agent).await;
    fx.exec.release(1);
    wait_for(&fx.agent, |s| s.iter().all(|e| e.get("role").is_some())).await;

    assert!(
        !cache_dir(&fx).exists(),
        "the finished synthesis recreated the folder"
    );
}

#[tokio::test]
async fn a_task_start_after_a_delete_on_a_never_loaded_cache_calls_nothing_and_writes_nothing() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), GOOD_REPLY)).await;

    super::super::discard_synthesis_cache(&fx.agent).await;
    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    settle().await;

    assert_eq!(fx.exec.config_reads(), 0);
    assert_eq!(fx.exec.model_calls(), 0);
    assert!(!cache_dir(&fx).exists());
    assert!(summaries(&fx.agent)
        .await
        .iter()
        .all(|c| c.get("role").is_none()));
}

const CARD_REPLY: &str = "Reading the sources before building";
const FINISH_REPLY: &str = "Built the thing and it passed";

fn wait_end(result: &str) -> Value {
    json!({
        "type": "tool_execution_end", "toolCallId": "wait-1", "toolName": "wait",
        "isError": false,
        "result": { "content": [], "details": { "jobs": [
            { "jobId": "job-0", "label": "Alpha", "status": "done", "resultText": result },
            { "jobId": "job-1", "label": "Beta", "status": "done", "resultText": result }
        ] } }
    })
}

fn card_summaries(cards: &[Value]) -> Vec<Option<String>> {
    cards
        .iter()
        .map(|c| {
            c.get("cardSummary")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .collect()
}

/// Starts the call through the real frame path, so the transcript and the cards both know the agents.
async fn start_task(fx: &Fixture) {
    let frame = json!({
        "type": "tool_execution_start", "toolCallId": "call-1", "toolName": "task", "args": task_args()
    });
    fx.agent.handle_frame(frame).await;
}

#[tokio::test]
async fn a_start_result_is_stored_and_emitted_on_each_card() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;

    start_task(&fx).await;
    wait_for(&fx.agent, |s| {
        card_summaries(s)
            .iter()
            .all(|c| c.as_deref() == Some(CARD_REPLY))
    })
    .await;

    let saved = SynthesisCache::load(&cache_dir(&fx));
    for index in 0..2 {
        let cards = saved.card_summaries("call-1", index).unwrap();
        assert_eq!(cards.start.as_deref(), Some(CARD_REPLY));
        assert_eq!(cards.finish, None);
    }
}

#[tokio::test]
async fn a_finish_result_replaces_the_start_result() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;
    start_task(&fx).await;
    wait_for(&fx.agent, |s| {
        card_summaries(s)
            .iter()
            .all(|c| c.as_deref() == Some(CARD_REPLY))
    })
    .await;

    fx.exec.set_reply(FINISH_REPLY);
    fx.agent.handle_frame(wait_end("It is built.")).await;
    wait_for(&fx.agent, |s| {
        card_summaries(s)
            .iter()
            .all(|c| c.as_deref() == Some(FINISH_REPLY))
    })
    .await;

    let saved = SynthesisCache::load(&cache_dir(&fx));
    let cards = saved.card_summaries("call-1", 0).unwrap();
    assert_eq!(cards.finish.as_deref(), Some(FINISH_REPLY));
}

#[tokio::test]
async fn with_the_setting_off_no_card_call_is_made() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;
    set_summarise_agent_cards(&fx, false).await;

    start_task(&fx).await;
    fx.agent.handle_frame(wait_end("It is built.")).await;
    settle().await;

    assert_eq!(
        fx.exec.model_calls(),
        1,
        "only the group synthesis may call"
    );
    assert!(card_summaries(&summaries(&fx.agent).await)
        .iter()
        .all(Option::is_none));
}

#[tokio::test]
async fn a_failed_card_call_leaves_the_card_summary_unset() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), "")).await;

    start_task(&fx).await;
    poll_until("the model was called", || fx.exec.model_calls() > 0).await;
    settle().await;

    assert!(card_summaries(&summaries(&fx.agent).await)
        .iter()
        .all(Option::is_none));
    assert_eq!(
        SynthesisCache::load(&cache_dir(&fx)).card_summaries("call-1", 0),
        None
    );
}

fn one_agent_args() -> Value {
    json!({ "tasks": [{ "name": "Alpha", "task": "Research the thing." }] })
}

async fn start_one_agent(fx: &Fixture) {
    let frame = json!({
        "type": "tool_execution_start", "toolCallId": "call-1", "toolName": "task", "args": one_agent_args()
    });
    fx.agent.handle_frame(frame).await;
}

fn wait_end_one(result: &str) -> Value {
    json!({
        "type": "tool_execution_end", "toolCallId": "wait-1", "toolName": "wait",
        "isError": false,
        "result": { "content": [], "details": { "jobs": [
            { "jobId": "job-0", "label": "Alpha", "status": "done", "resultText": result }
        ] } }
    })
}

fn first_card_summary(cards: &[Value]) -> Option<String> {
    card_summaries(cards).into_iter().next().flatten()
}

#[tokio::test]
async fn a_late_start_result_after_a_finish_leaves_the_finish_text() {
    let fx = fixture_with_cards(FakeExec::start_gated(roles_with_tiny(), CARD_REPLY)).await;
    start_one_agent(&fx).await;
    poll_until("the start call and the group call ran", || {
        fx.exec.model_calls() == 2
    })
    .await;

    fx.exec.set_reply(FINISH_REPLY);
    fx.agent.handle_frame(wait_end_one("It is built.")).await;
    wait_for(&fx.agent, |s| {
        first_card_summary(s).as_deref() == Some(FINISH_REPLY)
    })
    .await;
    fx.exec.release_starts(1);
    poll_until("the start result reached the cache", || {
        SynthesisCache::load(&cache_dir(&fx))
            .card_summaries("call-1", 0)
            .is_some_and(|cards| cards.start.is_some())
    })
    .await;
    settle().await;

    assert_eq!(
        first_card_summary(&summaries(&fx.agent).await).as_deref(),
        Some(FINISH_REPLY)
    );
    let saved = SynthesisCache::load(&cache_dir(&fx));
    let cards = saved.card_summaries("call-1", 0).unwrap();
    assert_eq!(cards.start.as_deref(), Some(CARD_REPLY));
    assert_eq!(cards.finish.as_deref(), Some(FINISH_REPLY));
}

#[tokio::test]
async fn a_failed_finish_call_keeps_the_start_summary_on_the_card_and_in_the_cache() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;
    start_task(&fx).await;
    wait_for(&fx.agent, |s| {
        card_summaries(s)
            .iter()
            .all(|c| c.as_deref() == Some(CARD_REPLY))
    })
    .await;
    poll_until("the start and group calls ran", || {
        fx.exec.model_calls() == 3
    })
    .await;

    fx.exec.set_reply("");
    fx.agent.handle_frame(wait_end("It is built.")).await;
    poll_until("both finish calls ran", || fx.exec.model_calls() == 5).await;
    settle().await;

    assert!(card_summaries(&summaries(&fx.agent).await)
        .iter()
        .all(|c| c.as_deref() == Some(CARD_REPLY)));
    let saved = SynthesisCache::load(&cache_dir(&fx));
    let cards = saved.card_summaries("call-1", 0).unwrap();
    assert_eq!(cards.start.as_deref(), Some(CARD_REPLY));
    assert_eq!(cards.finish, None);
}

#[tokio::test]
async fn turning_the_setting_off_between_start_and_finish_skips_the_finish_call() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;
    start_task(&fx).await;
    wait_for(&fx.agent, |s| {
        card_summaries(s)
            .iter()
            .all(|c| c.as_deref() == Some(CARD_REPLY))
    })
    .await;
    poll_until("the start and group calls ran", || {
        fx.exec.model_calls() == 3
    })
    .await;

    set_summarise_agent_cards(&fx, false).await;
    fx.exec.set_reply(FINISH_REPLY);
    fx.agent.handle_frame(wait_end("It is built.")).await;
    settle().await;

    assert_eq!(fx.exec.model_calls(), 3, "a finish call was made");
    assert!(card_summaries(&summaries(&fx.agent).await)
        .iter()
        .all(|c| c.as_deref() == Some(CARD_REPLY)));
}

#[tokio::test]
async fn a_repeated_start_frame_or_end_frame_costs_no_second_call() {
    let fx = fixture_with_cards(FakeExec::new(roles_with_tiny(), CARD_REPLY)).await;
    start_task(&fx).await;
    wait_for(&fx.agent, |s| {
        card_summaries(&s[..2])
            .iter()
            .all(|c| c.as_deref() == Some(CARD_REPLY))
    })
    .await;
    start_task(&fx).await;
    settle().await;
    assert_eq!(
        fx.exec.model_calls(),
        3,
        "two start calls and one group call"
    );

    fx.exec.set_reply(FINISH_REPLY);
    fx.agent.handle_frame(wait_end("It is built.")).await;
    // The repeated frame appends duplicate cards, so only the first two (the ones the calls label) are checked.
    wait_for(&fx.agent, |s| {
        card_summaries(&s[..2])
            .iter()
            .all(|c| c.as_deref() == Some(FINISH_REPLY))
    })
    .await;
    fx.agent.handle_frame(wait_end("It is built.")).await;
    fx.agent
        .handle_frame(json!({ "type": "message_end" }))
        .await;
    settle().await;

    assert_eq!(fx.exec.model_calls(), 5, "two finish calls only");
}
