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
    stopped: bool,
    asks: AtomicUsize,
    roles_set: Mutex<Vec<(String, String)>>,
    role_fails: bool,
    /// Run once when the role path asks for the status: a change made while the call is mid-way.
    on_status: Mutex<Option<(String, Option<String>)>>,
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
        if self.approve {
            Ok(())
        } else {
            Err(ToolError::new("denied", "the developer denied this action"))
        }
    }
    async fn known_roles(&self) -> Result<Vec<String>, ToolError> {
        Ok(vec!["default".into(), "smol".into()])
    }
    async fn status(&self, _id: &str) -> String {
        let flip = self.on_status.lock().unwrap().take();
        if let Some((id, parent)) = flip {
            self.registry
                .lock()
                .await
                .update_session(
                    &id,
                    SessionPatch {
                        parent_session_id: Some(parent),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        if self.stopped { "stopped" } else { "idle" }.into()
    }
    async fn set_role(&self, id: &str, role: &str) -> Result<(), ToolError> {
        if self.role_fails {
            return Err(ToolError::new("role_failed", "the role could not be set"));
        }
        self.roles_set
            .lock()
            .unwrap()
            .push((id.into(), role.into()));
        Ok(())
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

/// A registry holding `rows` in two Projects; the caller is `me`, not in `yolo`, approving.
async fn host(rows: Vec<Session>) -> FakeHost {
    let repos = [init_repo().await, init_repo().await];
    let dir = crate::test_scratch::path(format!("refract-update-{}", uuid::Uuid::new_v4()));
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
        yolo: false,
        approve: true,
        stopped: false,
        asks: AtomicUsize::new(0),
        roles_set: Mutex::new(Vec::new()),
        role_fails: false,
        on_status: Mutex::new(None),
    }
}

fn code(result: Result<Value, ToolError>) -> String {
    result.expect_err("expected a tool error").code
}

async fn parent_of(host: &FakeHost, id: &str) -> Option<String> {
    let sessions = host.registry.lock().await.snapshot().sessions;
    sessions
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
        .parent_session_id
}

/// me -> kid, plus an unrelated root `other` and a sibling root `peer`.
fn tree() -> Vec<Session> {
    vec![
        row("me", "repo", None),
        row("kid", "repo", Some("me")),
        row("other", "repo", None),
        row("peer", "repo", None),
    ]
}

#[tokio::test]
async fn nothing_to_change_an_empty_name_and_an_unknown_role_are_invalid_input() {
    let h = host(tree()).await;
    for args in [
        json!({ "id": "kid" }),
        json!({ "id": "kid", "name": "  " }),
        json!({ "id": "kid", "role": "nope" }),
        json!({ "id": "kid", "extra": 1 }),
    ] {
        assert_eq!(code(update_with(&h, &args).await), INVALID_INPUT, "{args}");
    }
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_target_or_parent_that_does_not_exist_is_not_found() {
    let h = host(tree()).await;
    let gone = update_with(&h, &json!({ "id": "ghost", "name": "x" })).await;
    assert_eq!(code(gone), NOT_FOUND);
    let no_parent = update_with(&h, &json!({ "id": "kid", "parent_id": "ghost" })).await;
    assert_eq!(code(no_parent), NOT_FOUND);
}

#[tokio::test]
async fn an_archived_or_other_project_parent_is_invalid_input() {
    let mut rows = tree();
    let mut archived = row("old", "repo", None);
    archived.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    rows.push(archived);
    rows.push(row("foreign", "elsewhere", None));
    let h = host(rows).await;
    for parent in ["old", "foreign"] {
        let result = update_with(&h, &json!({ "id": "kid", "parent_id": parent })).await;
        assert_eq!(code(result), INVALID_INPUT, "{parent}");
    }
}

#[tokio::test]
async fn nesting_under_itself_or_a_descendant_is_invalid_parent() {
    let mut rows = tree();
    rows.push(row("grandkid", "repo", Some("kid")));
    let h = host(rows).await;
    for parent in ["kid", "grandkid"] {
        let result = update_with(&h, &json!({ "id": "kid", "parent_id": parent })).await;
        assert_eq!(code(result), "invalid_parent", "{parent}");
    }
    assert_eq!(parent_of(&h, "kid").await.as_deref(), Some("me"));
}

#[tokio::test]
async fn a_subtree_that_would_exceed_depth_three_is_depth_limit() {
    let rows = vec![
        row("me", "repo", None),
        row("mid", "repo", Some("me")),
        // `branch` is a root with one child, so moving it under `mid` makes depth 4.
        row("branch", "repo", None),
        row("leaf", "repo", Some("branch")),
    ];
    let h = host(rows).await;
    let result = update_with(&h, &json!({ "id": "branch", "parent_id": "mid" })).await;
    assert_eq!(code(result), "depth_limit");
    assert_eq!(parent_of(&h, "branch").await, None);
}

#[tokio::test]
async fn a_new_parent_with_four_live_children_is_child_limit() {
    let mut rows = tree();
    for n in 0..4 {
        rows.push(row(&format!("k{n}"), "repo", Some("me")));
    }
    let h = host(rows).await;
    let result = update_with(&h, &json!({ "id": "other", "parent_id": "me" })).await;
    assert_eq!(code(result), "child_limit");
}

#[tokio::test]
async fn a_change_inside_the_own_tree_needs_no_card_and_null_un_nests() {
    let h = host(tree()).await;
    let out = update_with(&h, &json!({ "id": "kid", "parent_id": null }))
        .await
        .unwrap();
    assert!(out.get("parentId").is_none());
    assert_eq!(parent_of(&h, "kid").await, None);
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_change_outside_the_own_tree_asks_and_denial_changes_nothing() {
    let mut h = host(tree()).await;
    h.approve = false;
    let result = update_with(&h, &json!({ "id": "other", "name": "Renamed" })).await;
    assert_eq!(code(result), "denied");
    assert_eq!(h.asks.load(Ordering::SeqCst), 1);
    let sessions = h.registry.lock().await.snapshot().sessions;
    assert_eq!(
        sessions.iter().find(|s| s.id == "other").unwrap().name,
        "name-other"
    );
}

#[tokio::test]
async fn nesting_an_own_session_under_an_outside_one_asks() {
    let h = host(tree()).await;
    let out = update_with(&h, &json!({ "id": "kid", "parent_id": "other" }))
        .await
        .unwrap();
    assert_eq!(out["parentId"], "other");
    assert_eq!(h.asks.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn yolo_skips_the_card_outside_the_own_tree() {
    let mut h = host(tree()).await;
    h.yolo = true;
    update_with(&h, &json!({ "id": "other", "parent_id": "peer" }))
        .await
        .unwrap();
    assert_eq!(h.asks.load(Ordering::SeqCst), 0);
    assert_eq!(parent_of(&h, "other").await.as_deref(), Some("peer"));
}

#[tokio::test]
async fn a_rename_changes_the_name_and_reports_it() {
    let h = host(tree()).await;
    let out = update_with(&h, &json!({ "id": "kid", "name": "Fresh" }))
        .await
        .unwrap();
    assert_eq!(out["name"], "Fresh");
    assert_eq!(out["parentId"], "me");
}

#[tokio::test]
async fn a_role_change_applies_to_a_running_target_and_refuses_a_stopped_one() {
    let mut h = host(tree()).await;
    update_with(&h, &json!({ "id": "kid", "role": "smol" }))
        .await
        .unwrap();
    assert_eq!(
        h.roles_set.lock().unwrap().as_slice(),
        [("kid".to_string(), "smol".to_string())]
    );
    h.stopped = true;
    let err = update_with(&h, &json!({ "id": "kid", "name": "Z", "role": "smol" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, SESSION_NOT_RUNNING);
    assert!(err.message.contains("stopped"));
    let sessions = h.registry.lock().await.snapshot().sessions;
    assert_eq!(
        sessions.iter().find(|s| s.id == "kid").unwrap().name,
        "name-kid"
    );
}

#[tokio::test]
async fn two_racing_nests_at_three_live_children_yield_one_success() {
    let mut rows = vec![
        row("me", "repo", None),
        row("a", "repo", None),
        row("b", "repo", None),
    ];
    for n in 0..3 {
        rows.push(row(&format!("k{n}"), "repo", Some("me")));
    }
    let h = host(rows).await;
    let (a, b) = (
        json!({ "id": "a", "parent_id": "me" }),
        json!({ "id": "b", "parent_id": "me" }),
    );
    let (x, y) = tokio::join!(update_with(&h, &a), update_with(&h, &b));
    let codes: Vec<_> = [x, y].into_iter().map(|r| r.map_err(|e| e.code)).collect();
    assert_eq!(codes.iter().filter(|r| r.is_ok()).count(), 1, "{codes:?}");
    assert!(codes.contains(&Err("child_limit".to_string())), "{codes:?}");
}

#[tokio::test]
async fn an_update_waits_for_the_project_gate_before_writing() {
    let h = Arc::new(host(tree()).await);
    let held = tree_gate::lock("repo").await;
    let task = tokio::spawn({
        let h = h.clone();
        async move { update_with(&*h, &json!({ "id": "kid", "parent_id": null })).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(parent_of(&h, "kid").await.as_deref(), Some("me"));
    drop(held);
    task.await.unwrap().unwrap();
    assert_eq!(parent_of(&h, "kid").await, None);
}

#[tokio::test]
async fn a_target_that_leaves_the_own_tree_mid_call_is_cancelled_and_nothing_is_written() {
    let h = host(tree()).await;
    // `kid` is inside the caller's tree, so no card; it moves out before the gate re-check.
    *h.on_status.lock().unwrap() = Some(("kid".into(), Some("other".into())));
    let args = json!({ "id": "kid", "name": "Z", "role": "smol", "parent_id": null });
    assert_eq!(code(update_with(&h, &args).await), CANCELLED);
    assert!(h.roles_set.lock().unwrap().is_empty());
    let sessions = h.registry.lock().await.snapshot().sessions;
    let kid = sessions.iter().find(|s| s.id == "kid").unwrap();
    assert_eq!(kid.name, "name-kid");
    assert_eq!(kid.parent_session_id.as_deref(), Some("other"));
}

#[tokio::test]
async fn a_role_failure_leaves_the_name_and_the_parent_unwritten() {
    let mut h = host(tree()).await;
    h.role_fails = true;
    let args = json!({ "id": "kid", "name": "Z", "role": "smol", "parent_id": null });
    assert_eq!(code(update_with(&h, &args).await), "role_failed");
    let sessions = h.registry.lock().await.snapshot().sessions;
    let kid = sessions.iter().find(|s| s.id == "kid").unwrap();
    assert_eq!(kid.name, "name-kid");
    assert_eq!(kid.parent_session_id.as_deref(), Some("me"));
}
