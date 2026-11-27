// Session log removal against temp dirs only; never a real `~/.omp`.

use std::path::PathBuf;

use super::*;
use crate::store::registry::Session;

fn session_in(id: &str, dir: Option<&Path>) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: None,
        base_branch: None,
        worktree_path: None,
        session_dir: dir.map(|d| d.to_string_lossy().into_owned()),
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
        parent_session_id: None,
    }
}

/// A sessions root holding one folder with a Conversation, its artifact folder and a file that is
/// not a Conversation; returns `(root, folder)`.
fn folder_with_logs() -> (PathBuf, PathBuf) {
    let scratch = crate::test_scratch::path(format!("del-logs-{}", uuid::Uuid::new_v4()));
    let root = scratch.join("sessions-root");
    let folder = root.join("--c--work--repo--");
    std::fs::create_dir_all(folder.join("2026-01-01T00-00-00-000Z_a")).unwrap();
    std::fs::write(folder.join("2026-01-01T00-00-00-000Z_a.jsonl"), "{}\n").unwrap();
    std::fs::write(folder.join("2026-01-01T00-00-00-000Z_a/out.txt"), "x").unwrap();
    std::fs::write(folder.join("notes.txt"), "kept by OMP").unwrap();
    (root, folder)
}

#[tokio::test]
async fn a_sole_owner_removes_the_whole_session_folder() {
    let (root, folder) = folder_with_logs();

    delete_session_logs(&folder.to_string_lossy(), false, &root).await;

    assert!(!folder.exists());
    assert!(root.exists());
}

#[tokio::test]
async fn a_shared_folder_loses_only_its_conversation_files() {
    let (root, folder) = folder_with_logs();

    delete_session_logs(&folder.to_string_lossy(), true, &root).await;

    assert!(folder.join("notes.txt").exists());
    assert!(!folder.join("2026-01-01T00-00-00-000Z_a.jsonl").exists());
    assert!(!folder.join("2026-01-01T00-00-00-000Z_a").exists());
}

#[tokio::test]
async fn a_missing_folder_is_not_an_error() {
    let (root, folder) = folder_with_logs();

    delete_session_logs(&root.join("absent").to_string_lossy(), false, &root).await;

    assert!(folder.exists());
}

#[test]
fn another_session_on_the_same_folder_counts_as_sharing() {
    let dir = Path::new("C:/home/.omp/agent/sessions/--c--home--");
    let me = session_in("me", Some(dir));
    let other = session_in("other", Some(dir));

    assert!(shares_session_dir(&[me.clone(), other], &me));
}

#[test]
fn a_session_alone_on_its_folder_does_not_share() {
    let me = session_in(
        "me",
        Some(Path::new("C:/home/.omp/agent/sessions/--c--a--")),
    );
    let other = session_in(
        "other",
        Some(Path::new("C:/home/.omp/agent/sessions/--c--b--")),
    );
    let no_dir = session_in("nodir", None);

    assert!(!shares_session_dir(&[me.clone(), other, no_dir], &me));
}
