// Tests for `sessions.archive` with `includeChildren` (#1862), split from
// `sessions_lifecycle_tests.rs` for the 600-line cap. Each test uses its own Session ids because
// the delete-in-flight set is process-wide.

use super::tests::{make_repository, make_session, make_state, temp_registry_dir};
use super::*;

/// `p` with live child `c` and grandchild `g`, plus an already archived child `old`. With
/// `personal_child`, `c` is a Personal Agent row, which can never be archived.
async fn tree_state(label: &str, personal_child: bool) -> AppState {
    let state = make_state(&temp_registry_dir(label)).await;
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
            let mut row = make_session(&format!("{label}-{id}"), "repo-1", "C:/nowhere/wt", id);
            row.parent_session_id = parent.map(|p| format!("{label}-{p}"));
            if id == "old" {
                row.archived_at = Some("2026-01-01T00:00:00.000Z".to_string());
            }
            if id == "c" && personal_child {
                row.kind = crate::store::session_kind::SessionKind::Personal;
                row.repository_id = None;
                row.branch = None;
                row.base_branch = None;
                row.worktree_path = None;
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
    let state = tree_state(label, false).await;
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
        let state = tree_state(&label, false).await;
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
    let state = tree_state(label, false).await;
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
    let state = tree_state(label, false).await;
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

#[tokio::test]
async fn a_failure_part_way_names_what_was_already_archived() {
    let label = "sub-partial";
    let state = tree_state(label, true).await;
    // The cascade runs deepest first: `g` archives, then the Personal `c` refuses.
    let err = sessions_archive(
        state.clone(),
        args(&format!("{label}-p"), Value::Bool(true)),
    )
    .await
    .expect_err("the personal member must stop the cascade");
    assert_eq!(err.code, "personal-agent-protected");
    assert!(
        err.message
            .ends_with(&format!("already archived: {label}-g")),
        "{}",
        err.message
    );
    assert!(archived_at(&state, &format!("{label}-g")).await.is_some());
    assert!(archived_at(&state, &format!("{label}-p")).await.is_none());
}
