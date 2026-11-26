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
    reply: String,
    calls: StdMutex<Vec<Vec<String>>>,
    /// How long each model call takes, so a test can see calls overlap.
    model_delay: Duration,
    in_flight: AtomicUsize,
    peak_in_flight: AtomicUsize,
}

impl FakeExec {
    fn new(roles: serde_json::Value, reply: &str) -> Arc<Self> {
        Self::slow(roles, reply, Duration::ZERO)
    }

    fn slow(roles: serde_json::Value, reply: &str, model_delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            roles,
            reply: reply.to_string(),
            calls: StdMutex::new(Vec::new()),
            model_delay,
            in_flight: AtomicUsize::new(0),
            peak_in_flight: AtomicUsize::new(0),
        })
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
            tokio::time::sleep(self.model_delay).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(self.reply.clone())
        })
    }
}

fn roles_with_tiny() -> serde_json::Value {
    json!({ "default": "anthropic/claude-big", "smol": "anthropic/claude-mid", "tiny": "anthropic/claude-small" })
}

struct Fixture {
    agent: Arc<SessionAgent>,
    exec: Arc<FakeExec>,
    id: String,
    dir: PathBuf,
}

async fn fixture(exec: Arc<FakeExec>) -> Fixture {
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
    }
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
    while fx.exec.config_reads() == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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
    while fx.exec.config_reads() == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    settle().await;
    super::super::handle_task_start(&fx.agent, "call-2", &task_args()).await;
    settle().await;

    assert_eq!(fx.exec.config_reads(), 1);
    assert_eq!(fx.exec.model_calls(), 0);
}

#[tokio::test]
async fn a_burst_of_task_calls_reads_the_roles_once_and_runs_two_model_calls_at_a_time() {
    let fx = fixture(FakeExec::slow(
        roles_with_tiny(),
        GOOD_REPLY,
        Duration::from_millis(60),
    ))
    .await;

    for n in 0..5 {
        super::super::handle_task_start(&fx.agent, &format!("call-{n}"), &task_args()).await;
    }
    while fx.exec.model_calls() < 5 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    settle().await;

    assert_eq!(fx.exec.config_reads(), 1);
    assert_eq!(fx.exec.peak_in_flight.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_unusable_reply_leaves_the_cards_unlabelled_and_is_not_retried() {
    let fx = fixture(FakeExec::new(roles_with_tiny(), "no json here")).await;

    super::super::handle_task_start(&fx.agent, "call-1", &task_args()).await;
    while fx.exec.model_calls() == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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
