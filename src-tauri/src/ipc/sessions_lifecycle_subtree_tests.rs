// Tests for `sessions.archive` with `includeChildren` (#1862), split from
// `sessions_lifecycle_tests.rs` for the 600-line cap. Each test uses its own Session ids because
// the delete-in-flight set is process-wide.

use super::tests::{make_repository, make_session, make_state, temp_registry_dir};
use super::*;

/// `p` with live child `c` and grandchild `g`, plus an already archived child `old`.
async fn tree_state(label: &str) -> AppState {
    tree_state_in(&temp_registry_dir(label), label).await
}

async fn tree_state_in(dir: &std::path::Path, label: &str) -> AppState {
    let state = make_state(dir).await;
    {
        let mut store = state.registry.lock().await;
        store
            .add_repository(make_repository("repo-1", "C:/nowhere/repo"))
            .await
            .expect("add_repository");
        let rows = [
            ("p", None),
            ("c", Some("p")),
            ("g", Some("c")),
            ("old", Some("p")),
        ];
        for (id, parent) in rows {
            // The registry refuses two Sessions on one worktree path.
            let worktree = format!("C:/nowhere/wt-{label}-{id}");
            let mut row = make_session(&format!("{label}-{id}"), "repo-1", &worktree, id);
            row.parent_session_id = parent.map(|p| format!("{label}-{p}"));
            if id == "old" {
                row.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
            }
            store.add_session(row).await.expect("add_session");
        }
    }
    state
}

async fn archived_at(state: &AppState, id: &str) -> Option<String> {
    state
        .registry
        .lock()
        .await
        .get_session(id)
        .expect("session exists")
        .archived_at
        .clone()
}

fn args(id: &str, flag: Value) -> Vec<Value> {
    vec![Value::String(id.to_string()), flag]
}

#[tokio::test]
async fn archiving_with_children_archives_the_parent_and_every_live_descendant() {
    let label = "sub-all";
    let state = tree_state(label).await;
    sessions_archive(
        state.clone(),
        args(&format!("{label}-p"), Value::Bool(true)),
    )
    .await
    .expect("cascade archive");
    for id in ["p", "c", "g"] {
        assert!(
            archived_at(&state, &format!("{label}-{id}"))
                .await
                .is_some(),
            "{id} must be archived"
        );
    }
    // The cascade leaves an already archived child's original stamp alone.
    assert_eq!(
        archived_at(&state, &format!("{label}-old"))
            .await
            .as_deref(),
        Some("2026-01-01T00:00:00.000Z")
    );
}

#[tokio::test]
async fn archiving_without_children_leaves_the_descendants_live() {
    for flag in [Some(Value::Bool(false)), Some(Value::Null), None] {
        let label = format!("sub-one-{}", flag.is_some());
        let state = tree_state(&label).await;
        let mut call = vec![Value::String(format!("{label}-p"))];
        call.extend(flag);
        sessions_archive(state.clone(), call)
            .await
            .expect("archive");
        assert!(archived_at(&state, &format!("{label}-p")).await.is_some());
        assert!(archived_at(&state, &format!("{label}-c")).await.is_none());
        assert!(archived_at(&state, &format!("{label}-g")).await.is_none());
    }
}

#[tokio::test]
async fn a_non_boolean_include_children_is_an_invalid_argument_and_changes_nothing() {
    let label = "sub-bad-arg";
    let state = tree_state(label).await;
    let err = sessions_archive(
        state.clone(),
        args(&format!("{label}-p"), Value::from("yes")),
    )
    .await
    .expect_err("a string flag must be refused");
    assert_eq!(err.code, "invalid-argument");
    assert!(archived_at(&state, &format!("{label}-p")).await.is_none());
}

#[tokio::test]
async fn a_member_being_deleted_refuses_the_cascade_before_anything_is_archived() {
    let label = "sub-deleting";
    let state = tree_state(label).await;
    let _claim = delete_in_flight::claim(&format!("{label}-g")).expect("claim");
    let err = sessions_archive(
        state.clone(),
        args(&format!("{label}-p"), Value::Bool(true)),
    )
    .await
    .expect_err("a deleting member must refuse");
    assert_eq!(err.code, delete_in_flight::ALREADY_DELETING);
    assert!(archived_at(&state, &format!("{label}-p")).await.is_none());
    assert!(archived_at(&state, &format!("{label}-c")).await.is_none());
}

#[test]
fn a_failure_part_way_names_what_was_already_archived() {
    let error = IpcError::new("personal-agent-protected", "refused");
    let named = archive_core::partial_failure(error, &["g".to_string(), "c".to_string()]);
    assert_eq!(named.code, "personal-agent-protected");
    assert_eq!(named.message, "refused; already archived: g, c");
}

#[test]
fn a_failure_before_anything_was_archived_keeps_its_message() {
    let named = archive_core::partial_failure(IpcError::new("not-found", "gone"), &[]);
    assert_eq!(named.message, "gone");
}

/// The tree of `tree_state` with `c` rewritten as a Personal Agent row. `add_session` refuses a
/// nested Personal Agent, but the registry is a hand-editable file, so the cascade must still stop
/// cleanly on one: it is the only member `archive_core` refuses that the up-front check does not.
async fn state_with_personal_child(label: &str) -> AppState {
    let dir = temp_registry_dir(label);
    let seeded = tree_state_in(&dir, label).await;
    let mut snapshot = seeded.registry.lock().await.snapshot();
    let child = snapshot
        .sessions
        .iter_mut()
        .find(|s| s.id == format!("{label}-c"))
        .expect("child row");
    child.kind = crate::store::session_kind::SessionKind::Personal;
    child.repository_id = None;
    child.branch = None;
    child.base_branch = None;
    child.worktree_path = None;
    std::fs::write(
        dir.join("registry.json"),
        serde_json::to_vec(&snapshot).expect("serialise registry"),
    )
    .expect("write registry");
    make_state(&dir).await
}

#[tokio::test]
async fn a_member_that_fails_part_way_reports_what_was_already_archived() {
    let label = "sub-mid-fail";
    let state = state_with_personal_child(label).await;
    // Deepest first: `g` is archived, then `c` (the Personal Agent) refuses, so `p` is never reached.
    let err = archive_core::archive_subtree_core(&state, &format!("{label}-p"))
        .await
        .expect_err("the Personal Agent member must stop the cascade");
    assert_eq!(err.code, "personal-agent-protected");
    assert!(
        err.message
            .ends_with(&format!("already archived: {label}-g")),
        "the error must name the member already archived, got: {}",
        err.message
    );
    assert!(archived_at(&state, &format!("{label}-g")).await.is_some());
    assert!(archived_at(&state, &format!("{label}-c")).await.is_none());
    assert!(archived_at(&state, &format!("{label}-p")).await.is_none());
}

#[tokio::test]
async fn archiving_a_subtree_of_an_unknown_id_is_not_found() {
    let state = make_state(&temp_registry_dir("sub-unknown")).await;
    let err = archive_core::archive_subtree_core(&state, "sub-unknown-ghost")
        .await
        .expect_err("an unknown id must be refused");
    assert_eq!(err.code, "not-found");
}

#[tokio::test]
async fn archiving_a_subtree_from_a_non_project_session_is_not_found_and_changes_nothing() {
    let label = "sub-personal-root";
    let state = tree_state(label).await;
    let mut row = make_session("sub-personal-root-pa", "repo-1", "C:/nowhere/pa", "pa");
    row.kind = crate::store::session_kind::SessionKind::Personal;
    row.repository_id = None;
    row.branch = None;
    row.base_branch = None;
    row.worktree_path = None;
    state
        .registry
        .lock()
        .await
        .add_session(row)
        .await
        .expect("add personal");
    let err = archive_core::archive_subtree_core(&state, "sub-personal-root-pa")
        .await
        .expect_err("a Personal Agent has no Project subtree");
    assert_eq!(err.code, "not-found");
    assert!(archived_at(&state, "sub-personal-root-pa").await.is_none());
    assert!(archived_at(&state, &format!("{label}-p")).await.is_none());
}
