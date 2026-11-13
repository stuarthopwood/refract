use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::git::test_support::init_repo;
use crate::store::registry::{RegistryStore, Repository};

struct FakeHost {
    caller: String,
    registry: SharedRegistry,
    yolo: bool,
    approve: bool,
    start_fails: bool,
    asks: AtomicUsize,
    started: Mutex<Vec<(String, Option<String>, String)>>,
    /// Deleted while the card is open, as a developer deleting the caller would.
    delete_on_ask: Option<String>,
}

impl Host for FakeHost {
    fn caller_id(&self) -> &str {
        &self.caller
    }
    fn call_id(&self) -> &str {
        "call-1"
    }
    fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
    async fn is_yolo(&self) -> bool {
        self.yolo
    }
    async fn ask(&self, _card: PendingRequest) -> Result<(), ToolError> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        if let Some(id) = &self.delete_on_ask {
            self.registry.lock().await.remove_session(id).await.unwrap();
        }
        if self.approve {
            Ok(())
        } else {
            Err(ToolError::new("denied", "the developer denied this action"))
        }
    }
    async fn known_roles(&self) -> Result<Vec<String>, ToolError> {
        Ok(vec!["default".into(), "smol".into()])
    }
    async fn start(&self, id: &str, role: Option<&str>, turn: String) -> Result<(), ToolError> {
        if self.start_fails {
            return Err(ToolError::new("agent-start-failed", "omp would not start"));
        }
        self.started
            .lock()
            .unwrap()
            .push((id.into(), role.map(str::to_string), turn));
        Ok(())
    }
    async fn status(&self, _id: &str) -> String {
        "idle".into()
    }
}

fn row(id: &str, repo: &str, parent: Option<&str>) -> Session {
    Session {
        id: id.into(),
        repository_id: repo.into(),
        name: format!("name-{id}"),
        branch: id.into(),
        base_branch: "main".into(),
        worktree_path: format!("C:/worktrees/{id}"),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        last_activity_at: "2026-01-01T00:00:00.000Z".into(),
        archived_at: None,
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: parent.map(str::to_string),
    }
}

/// A real repo (so the Worktree and branch checks are real) holding `rows`; caller is `me`.
async fn host(rows: Vec<Session>) -> FakeHost {
    let repos = [init_repo().await, init_repo().await];
    let dir = crate::test_scratch::path(format!("refract-create-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut store = RegistryStore::open(&dir).await.unwrap();
    for (id, repo) in ["repo", "elsewhere"].into_iter().zip(&repos) {
        store
            .add_repository(Repository {
                id: id.into(),
                path: repo.to_string_lossy().into_owned(),
                name: id.into(),
                default_branch: "main".into(),
                added_at: "2026-01-01T00:00:00.000Z".into(),
                color: None,
            })
            .await
            .unwrap();
    }
    for session in rows {
        store.add_session(session).await.unwrap();
    }
    FakeHost {
        caller: "me".into(),
        registry: Arc::new(AsyncMutex::new(store)),
        yolo: true,
        approve: true,
        start_fails: false,
        asks: AtomicUsize::new(0),
        started: Mutex::new(Vec::new()),
        delete_on_ask: None,
    }
}

async fn session_count(host: &FakeHost) -> usize {
    host.registry.lock().await.snapshot().sessions.len()
}

fn code(result: Result<Value, ToolError>) -> String {
    result.expect_err("expected a tool error").code
}

fn me() -> Vec<Session> {
    vec![row("me", "repo", None)]
}

#[tokio::test]
async fn an_empty_or_oversized_prompt_is_invalid_input_before_any_card() {
    let mut h = host(me()).await;
    h.yolo = false;
    let big = "x".repeat(MAX_TEXT_BYTES + 1);
    for prompt in ["  ", big.as_str()] {
        let result = create_with(&h, &json!({ "prompt": prompt })).await;
        assert_eq!(code(result), INVALID_INPUT);
    }
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn arguments_the_schema_forbids_are_invalid_input_before_any_card() {
    let mut h = host(me()).await;
    h.yolo = false;
    for args in [
        json!({ "prompt": "p", "bogus": 1 }),
        json!({ "prompt": "p", "role": 5 }),
        json!({ "prompt": "p", "name": ["a"] }),
        json!({ "name": "no prompt" }),
    ] {
        assert_eq!(code(create_with(&h, &args).await), INVALID_INPUT, "{args}");
    }
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
    assert_eq!(session_count(&h).await, 1);
}

#[tokio::test]
async fn unknown_role_branch_and_bad_parents_are_checked_before_the_card() {
    let mut rows = me();
    let mut archived = row("old", "repo", None);
    archived.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    rows.push(archived);
    rows.push(row("foreign", "elsewhere", None));
    let mut h = host(rows).await;
    h.yolo = false;
    for args in [
        json!({ "prompt": "p", "role": "nope" }),
        json!({ "prompt": "p", "base_branch": "no-such-branch" }),
        json!({ "prompt": "p", "parent_id": "old" }),
        json!({ "prompt": "p", "parent_id": "foreign" }),
    ] {
        assert_eq!(code(create_with(&h, &args).await), INVALID_INPUT, "{args}");
    }
    let missing = create_with(&h, &json!({ "prompt": "p", "parent_id": "ghost" })).await;
    assert_eq!(code(missing), NOT_FOUND);
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
    assert_eq!(session_count(&h).await, 3);
}

#[tokio::test]
async fn a_caller_at_depth_three_gets_depth_limit_and_no_card() {
    let rows = vec![
        row("top", "repo", None),
        row("mid", "repo", Some("top")),
        row("me", "repo", Some("mid")),
    ];
    let mut h = host(rows).await;
    h.yolo = false;
    let result = create_with(&h, &json!({ "prompt": "p" })).await;
    assert_eq!(code(result), "depth_limit");
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_parent_with_four_live_children_gets_child_limit_but_an_archived_one_frees_a_slot() {
    let mut rows = me();
    for n in 0..4 {
        rows.push(row(&format!("k{n}"), "repo", Some("me")));
    }
    let h = host(rows).await;
    assert_eq!(code(create_with(&h, &json!({ "prompt": "p" })).await), "child_limit");
    h.registry
        .lock()
        .await
        .update_session(
            "k0",
            crate::store::registry::SessionPatch {
                archived_at: Some(Some("2026-01-02T00:00:00.000Z".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(create_with(&h, &json!({ "prompt": "p" })).await.is_ok());
}

#[tokio::test]
async fn denial_creates_nothing_and_starts_nothing() {
    let mut h = host(me()).await;
    h.yolo = false;
    h.approve = false;
    let result = create_with(&h, &json!({ "prompt": "p" })).await;
    assert_eq!(code(result), "denied");
    assert_eq!(h.asks.load(Ordering::SeqCst), 1);
    assert_eq!(session_count(&h).await, 1);
    assert!(h.started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn approval_creates_and_yolo_skips_the_card() {
    let mut h = host(me()).await;
    h.yolo = false;
    assert!(create_with(&h, &json!({ "prompt": "p" })).await.is_ok());
    assert_eq!(h.asks.load(Ordering::SeqCst), 1);
    h.yolo = true;
    assert!(create_with(&h, &json!({ "prompt": "p" })).await.is_ok());
    assert_eq!(h.asks.load(Ordering::SeqCst), 1, "yolo must not ask again");
}

#[tokio::test]
async fn the_child_defaults_to_the_caller_as_parent_and_gets_the_parent_line() {
    let h = host(me()).await;
    let out = create_with(&h, &json!({ "prompt": "do it", "name": "Kid" })).await.unwrap();
    assert_eq!(out["parentId"], "me");
    assert_eq!(out["name"], "Kid");
    assert_eq!(out["status"], "idle");
    let started = h.started.lock().unwrap();
    assert_eq!(started[0].0, out["id"].as_str().unwrap());
    assert_eq!(
        started[0].2,
        "[Parent Session: \"name-me\" (id me). When you finish, report back with \
refract_send_session_message to that id.]\n\ndo it"
    );
    let sessions = h.registry.try_lock().unwrap().snapshot().sessions;
    let child = sessions.iter().find(|s| s.id == out["id"]).unwrap();
    assert_eq!(child.parent_session_id.as_deref(), Some("me"));
    assert_eq!(child.name, "Kid");
}

#[tokio::test]
async fn a_null_parent_makes_a_root_with_the_bare_prompt() {
    let h = host(me()).await;
    let out = create_with(&h, &json!({ "prompt": "solo", "parent_id": null }))
        .await
        .unwrap();
    assert!(out.get("parentId").is_none());
    assert_eq!(h.started.lock().unwrap()[0].2, "solo");
}

#[tokio::test]
async fn the_role_is_passed_only_when_given_and_never_inherited() {
    let h = host(me()).await;
    create_with(&h, &json!({ "prompt": "a", "role": "smol" })).await.unwrap();
    create_with(&h, &json!({ "prompt": "b" })).await.unwrap();
    let started = h.started.lock().unwrap();
    assert_eq!(started[0].1.as_deref(), Some("smol"));
    assert_eq!(started[1].1, None);
}

#[tokio::test]
async fn two_racing_creates_at_three_live_children_yield_one_success() {
    let mut rows = me();
    for n in 0..3 {
        rows.push(row(&format!("k{n}"), "repo", Some("me")));
    }
    let h = host(rows).await;
    let args = json!({ "prompt": "p" });
    let (a, b) = tokio::join!(create_with(&h, &args), create_with(&h, &args));
    let codes: Vec<_> = [a, b].into_iter().map(|r| r.map_err(|e| e.code)).collect();
    assert_eq!(codes.iter().filter(|r| r.is_ok()).count(), 1, "{codes:?}");
    assert!(codes.contains(&Err("child_limit".to_string())), "{codes:?}");
    assert_eq!(session_count(&h).await, 5);
}

#[tokio::test]
async fn a_start_failure_keeps_the_session_and_names_its_id() {
    let mut h = host(me()).await;
    h.start_fails = true;
    let err = create_with(&h, &json!({ "prompt": "p" })).await.unwrap_err();
    assert_eq!(err.code, START_FAILED);
    let sessions = h.registry.lock().await.snapshot().sessions;
    assert_eq!(sessions.len(), 2);
    let kept = sessions.iter().find(|s| s.id != "me").unwrap();
    assert!(err.message.contains(&kept.id), "{}", err.message);
}

#[tokio::test]
async fn a_caller_deleted_while_the_card_is_open_cancels_with_no_link() {
    let mut h = host(me()).await;
    h.yolo = false;
    h.delete_on_ask = Some("me".into());
    let result = create_with(&h, &json!({ "prompt": "p" })).await;
    assert_eq!(code(result), CANCELLED);
    assert_eq!(session_count(&h).await, 0);
    assert!(h.started.lock().unwrap().is_empty());
}
