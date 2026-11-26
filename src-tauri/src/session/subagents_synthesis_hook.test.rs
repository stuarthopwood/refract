// Hook tests: a fake executor counts every `omp` call, so no test ever reaches a real model.
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::omp::config::OmpConfigError;
use crate::store::registry::Session;

type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>>;

const GOOD_REPLY: &str = r#"{"overallGoal": "Ship the card", "roles": ["Researcher", "Builder"]}"#;

/// Answers `omp config get modelRoles` from `roles` and every other call with `reply`, recording both.
struct FakeExec {
    roles: serde_json::Value,
    reply: String,
    calls: StdMutex<Vec<Vec<String>>>,
}

impl FakeExec {
    fn new(roles: serde_json::Value, reply: &str) -> Arc<Self> {
        Arc::new(Self {
            roles,
            reply: reply.to_string(),
            calls: StdMutex::new(Vec::new()),
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
        let body = if args.first().map(String::as_str) == Some("config") {
            json!({ "key": "modelRoles", "value": self.roles, "type": "record", "description": "" })
                .to_string()
        } else {
            self.reply.clone()
        };
        Box::pin(async move { Ok(body) })
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
    let id = format!("session-synth-{}", uuid::Uuid::new_v4());
    let dir = crate::test_scratch::path(format!("refract-synth-hook-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo-synth".to_string(),
            path: dir.join("repo").to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-11-26T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .unwrap();
    registry_store
        .add_session(Session {
            id: id.clone(),
            kind: crate::store::session_kind::SessionKind::Project,
            repository_id: Some("repo-synth".to_string()),
            name: "test".to_string(),
            branch: Some("feat/test".to_string()),
            base_branch: Some("main".to_string()),
            worktree_path: Some(dir.join("worktree").to_string_lossy().into_owned()),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-11-26T00:00:00.000Z".to_string(),
            last_activity_at: "2026-11-26T00:00:00.000Z".to_string(),
            archived_at: None,
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
            parent_session_id: None,
        })
        .await
        .unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(registry_store));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    let agent = manager.get_or_create_agent(&id);
    let injected = exec.clone();
    agent
        .with_subagents_state(|s| s.synthesis.exec = injected)
        .await;
    Fixture {
        agent,
        exec,
        id,
        dir,
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
        .insert_and_persist(
            "call-1",
            Synthesis {
                overall_goal: Some("From disk".to_string()),
                roles: vec![None, Some("Cached builder".to_string())],
            },
        )
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
