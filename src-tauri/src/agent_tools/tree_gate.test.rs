use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;

fn session(id: &str, parent: Option<&str>) -> Session {
    Session {
        id: id.to_string(),
        repository_id: "repo".to_string(),
        name: id.to_string(),
        branch: id.to_string(),
        base_branch: "main".to_string(),
        worktree_path: format!("C:/worktrees/{id}"),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
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

// me -> kid; other is a separate root.
fn tree() -> Vec<Session> {
    vec![
        session("me", None),
        session("kid", Some("me")),
        session("other", None),
    ]
}

#[test]
fn own_tree_rule_table() {
    let s = tree();
    assert!(inside_own_tree(&s, "me", "me", None));
    assert!(inside_own_tree(&s, "me", "kid", None));
    assert!(inside_own_tree(&s, "me", "kid", Some("me")));
    assert!(!inside_own_tree(&s, "me", "other", None));
    assert!(!inside_own_tree(&s, "me", "other", Some("me")));
    assert!(!inside_own_tree(&s, "me", "kid", Some("other")));
    assert!(!inside_own_tree(&s, "kid", "me", None));
}

#[test]
fn tree_errors_map_to_codes() {
    assert_eq!(error_code(TreeError::InvalidParent), "invalid_parent");
    assert_eq!(error_code(TreeError::DepthLimit), "depth_limit");
    assert_eq!(error_code(TreeError::ChildLimit), "child_limit");
}

#[tokio::test]
async fn the_gate_serialises_two_callers() {
    let first = lock().await;
    let entered = Arc::new(AtomicBool::new(false));
    let flag = entered.clone();
    let second = tokio::spawn(async move {
        let _guard = lock().await;
        flag.store(true, Ordering::SeqCst);
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!entered.load(Ordering::SeqCst));
    drop(first);
    second.await.unwrap();
    assert!(entered.load(Ordering::SeqCst));
}
