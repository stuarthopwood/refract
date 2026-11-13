// Scratch dirs are left in the OS temp folder. No race tests: `&mut self` prevents interleaving.

use super::*;

fn fresh_dir() -> PathBuf {
    crate::test_scratch::path(format!("refract-registry-test-{}", uuid::Uuid::new_v4()))
}

fn make_repository(id: &str, path: &str) -> Repository {
    Repository {
        id: id.to_string(),
        path: path.to_string(),
        name: "pinion".to_string(),
        default_branch: "main".to_string(),
        added_at: "2026-01-01T00:00:00.000Z".to_string(),
        color: None,
    }
}

fn make_session(id: &str, repository_id: &str) -> Session {
    Session {
        id: id.to_string(),
        repository_id: repository_id.to_string(),
        name: "Test Session".to_string(),
        branch: "swift-otter".to_string(),
        base_branch: "main".to_string(),
        worktree_path: "C:/worktrees/swift-otter".to_string(),
        session_dir: Some("C:/sessions/swift-otter".to_string()),
        current_conversation: Some("C:/sessions/swift-otter/conv.jsonl".to_string()),
        last_message_count: Some(10),
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

/// Makes the NEXT write to `dir/registry.json` fail by swapping the file for a same-named
/// directory (rename onto a directory fails). Returns the old bytes for `restore_write`.
async fn break_next_write(dir: &Path) -> Vec<u8> {
    let file = dir.join("registry.json");
    let backup = tokio::fs::read(&file)
        .await
        .expect("registry.json must already exist from an earlier successful write");
    tokio::fs::remove_file(&file)
        .await
        .expect("remove registry.json");
    tokio::fs::create_dir(&file)
        .await
        .expect("replace registry.json with a directory");
    backup
}

/// Undoes `break_next_write`: removes the stand-in directory and restores the old bytes.
async fn restore_write(dir: &Path, backup: Vec<u8>) {
    let file = dir.join("registry.json");
    tokio::fs::remove_dir(&file)
        .await
        .expect("remove stand-in directory");
    tokio::fs::write(&file, backup)
        .await
        .expect("restore registry.json");
}

#[tokio::test]
async fn update_repository_name_persists_a_rename_across_reopen() {
    let dir = fresh_dir();
    let repository = make_repository("repo-1", "C:/repos/pinion");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(repository.clone()).await.unwrap();

    let updated = store
        .update_repository_name(&repository.id, "Renamed".to_string())
        .await
        .unwrap();
    assert_eq!(updated.name, "Renamed");
    assert_eq!(updated.path, repository.path);

    let reopened = RegistryStore::open(&dir).await.unwrap();
    let persisted = reopened.get_repository(&repository.id).unwrap();
    assert_eq!(persisted.name, "Renamed");
    assert_eq!(persisted.path, repository.path);
}

#[tokio::test]
async fn update_repository_name_not_found_for_unknown_id() {
    let dir = fresh_dir();
    let mut store = RegistryStore::open(&dir).await.unwrap();

    let err = store
        .update_repository_name("missing-id", "X".to_string())
        .await
        .unwrap_err();
    match err {
        RegistryStoreError::Registry(e) => assert_eq!(e.code, RegistryErrorCode::NotFound),
        RegistryStoreError::Io(e) => panic!("expected a RegistryError, got Io({e})"),
    }
}

#[tokio::test]
async fn update_repository_name_allows_two_repositories_to_share_a_display_name() {
    let dir = fresh_dir();
    let a = make_repository("repo-a", "C:/repos/a");
    let b = make_repository("repo-b", "C:/repos/b");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(a.clone()).await.unwrap();
    store.add_repository(b.clone()).await.unwrap();

    store
        .update_repository_name(&a.id, "Same name".to_string())
        .await
        .unwrap();
    let updated_b = store
        .update_repository_name(&b.id, "Same name".to_string())
        .await
        .unwrap();
    assert_eq!(updated_b.name, "Same name");
    assert_eq!(store.get_repository(&a.id).unwrap().name, "Same name");
}

#[tokio::test]
async fn update_repository_name_rolls_back_in_memory_on_a_failed_write() {
    let dir = fresh_dir();
    let repository = make_repository("repo-1", "C:/repos/pinion");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(repository.clone()).await.unwrap();

    let backup = break_next_write(&dir).await;
    let err = store
        .update_repository_name(&repository.id, "Should not stick".to_string())
        .await
        .unwrap_err();
    assert!(matches!(err, RegistryStoreError::Io(_)));
    assert_eq!(
        store.get_repository(&repository.id).unwrap().name,
        repository.name
    );

    restore_write(&dir, backup).await;
}

#[tokio::test]
async fn update_session_rolls_back_in_memory_fields_on_a_failed_write() {
    let dir = fresh_dir();
    let repository = make_repository("repo-1", "C:/repos/pinion");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(repository.clone()).await.unwrap();
    let session = make_session("session-1", &repository.id);
    store.add_session(session.clone()).await.unwrap();

    let backup = break_next_write(&dir).await;
    let err = store
        .update_session(
            &session.id,
            SessionPatch {
                current_conversation: Some(Some("C:/sessions/swift-otter/other.jsonl".to_string())),
                last_message_count: Some(Some(99)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, RegistryStoreError::Io(_)));
    let current = store.get_session(&session.id).unwrap();
    assert_eq!(current.current_conversation, session.current_conversation);
    assert_eq!(current.last_message_count, session.last_message_count);

    restore_write(&dir, backup).await;
}

#[tokio::test]
async fn update_session_reopened_store_does_not_contain_the_failed_patch() {
    let dir = fresh_dir();
    let repository = make_repository("repo-1", "C:/repos/pinion");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(repository.clone()).await.unwrap();
    let session = make_session("session-1", &repository.id);
    store.add_session(session.clone()).await.unwrap();

    let backup = break_next_write(&dir).await;
    let err = store
        .update_session(
            &session.id,
            SessionPatch {
                current_conversation: Some(Some("C:/sessions/swift-otter/other.jsonl".to_string())),
                last_message_count: Some(Some(99)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, RegistryStoreError::Io(_)));
    restore_write(&dir, backup).await;

    let reopened = RegistryStore::open(&dir).await.unwrap();
    let persisted = reopened.get_session(&session.id).unwrap();
    assert_eq!(persisted.current_conversation, session.current_conversation);
    assert_eq!(persisted.last_message_count, session.last_message_count);
}

#[tokio::test]
async fn update_session_a_real_subsequent_write_still_succeeds_after_an_earlier_one_failed() {
    let dir = fresh_dir();
    let repository = make_repository("repo-1", "C:/repos/pinion");
    let mut store = RegistryStore::open(&dir).await.unwrap();
    store.add_repository(repository.clone()).await.unwrap();
    let session = make_session("session-1", &repository.id);
    store.add_session(session.clone()).await.unwrap();

    let backup = break_next_write(&dir).await;
    let err = store
        .update_session(
            &session.id,
            SessionPatch {
                current_conversation: Some(Some("C:/sessions/swift-otter/other.jsonl".to_string())),
                last_message_count: Some(Some(99)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, RegistryStoreError::Io(_)));
    restore_write(&dir, backup).await;

    let updated = store
        .update_session(
            &session.id,
            SessionPatch {
                last_activity_at: Some("2026-02-02T00:00:00.000Z".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.last_activity_at, "2026-02-02T00:00:00.000Z");
    assert_eq!(updated.current_conversation, session.current_conversation);

    let reopened = RegistryStore::open(&dir).await.unwrap();
    let persisted = reopened.get_session(&session.id).unwrap();
    assert_eq!(persisted.last_activity_at, "2026-02-02T00:00:00.000Z");
    assert_eq!(persisted.current_conversation, session.current_conversation);
}

/// A distinct-worktree Session, so several can share one registry.
fn make_child(id: &str, repository_id: &str, parent: Option<&str>) -> Session {
    let mut session = make_session(id, repository_id);
    session.branch = format!("branch-{id}");
    session.worktree_path = format!("C:/worktrees/{id}");
    session.parent_session_id = parent.map(str::to_string);
    session
}

async fn store_with(dir: &Path, rows: Vec<Session>) -> RegistryStore {
    let mut store = RegistryStore::open(dir).await.unwrap();
    store
        .add_repository(make_repository("repo-1", "C:/repos/pinion"))
        .await
        .unwrap();
    for row in rows {
        store.add_session(row).await.unwrap();
    }
    store
}

#[tokio::test]
async fn a_registry_written_before_parent_links_loads_with_no_parents() {
    let dir = fresh_dir();
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let old = r#"{"version":1,"repositories":[{"id":"repo-1","path":"C:/repos/pinion","name":"pinion","defaultBranch":"main","addedAt":"2026-01-01T00:00:00.000Z"}],
        "sessions":[{"id":"s1","repositoryId":"repo-1","name":"n","branch":"b","baseBranch":"main","worktreePath":"C:/w/s1","sessionDir":null,"currentConversation":null,"lastMessageCount":null,"createdAt":"2026-01-01T00:00:00.000Z","lastActivityAt":"2026-01-01T00:00:00.000Z","archivedAt":null}]}"#;
    tokio::fs::write(dir.join("registry.json"), old)
        .await
        .unwrap();

    let store = RegistryStore::open(&dir).await.unwrap();
    assert_eq!(store.get_session("s1").unwrap().parent_session_id, None);
}

#[tokio::test]
async fn parent_session_id_round_trips_and_is_omitted_when_none() {
    let dir = fresh_dir();
    let store = store_with(
        &dir,
        vec![
            make_child("p", "repo-1", None),
            make_child("c", "repo-1", Some("p")),
        ],
    )
    .await;
    drop(store);

    let reopened = RegistryStore::open(&dir).await.unwrap();
    assert_eq!(
        reopened
            .get_session("c")
            .unwrap()
            .parent_session_id
            .as_deref(),
        Some("p")
    );
    assert_eq!(reopened.get_session("p").unwrap().parent_session_id, None);
    let text = tokio::fs::read_to_string(dir.join("registry.json"))
        .await
        .unwrap();
    assert_eq!(text.matches("parentSessionId").count(), 1);
}

#[tokio::test]
async fn update_session_sets_and_clears_the_parent_and_none_leaves_it() {
    let dir = fresh_dir();
    let mut store = store_with(
        &dir,
        vec![
            make_child("p", "repo-1", None),
            make_child("c", "repo-1", None),
        ],
    )
    .await;

    let set = SessionPatch {
        parent_session_id: Some(Some("p".to_string())),
        ..Default::default()
    };
    let updated = store.update_session("c", set).await.unwrap();
    assert_eq!(updated.parent_session_id.as_deref(), Some("p"));

    let unrelated = SessionPatch {
        last_activity_at: Some("2026-02-02T00:00:00.000Z".to_string()),
        ..Default::default()
    };
    let updated = store.update_session("c", unrelated).await.unwrap();
    assert_eq!(updated.parent_session_id.as_deref(), Some("p"));

    let clear = SessionPatch {
        parent_session_id: Some(None),
        ..Default::default()
    };
    let updated = store.update_session("c", clear).await.unwrap();
    assert_eq!(updated.parent_session_id, None);
    let reopened = RegistryStore::open(&dir).await.unwrap();
    assert_eq!(reopened.get_session("c").unwrap().parent_session_id, None);
}

#[tokio::test]
async fn removing_a_session_re_roots_its_live_children_in_the_same_write() {
    let dir = fresh_dir();
    let mut archived_child = make_child("old", "repo-1", Some("p"));
    archived_child.archived_at = Some("2026-01-02T00:00:00.000Z".to_string());
    let mut store = store_with(
        &dir,
        vec![
            make_child("p", "repo-1", None),
            make_child("live", "repo-1", Some("p")),
            archived_child,
            make_child("other", "repo-1", Some("q")),
        ],
    )
    .await;

    store.remove_session("p").await.unwrap();
    let reopened = RegistryStore::open(&dir).await.unwrap();
    assert_eq!(
        reopened.get_session("live").unwrap().parent_session_id,
        None
    );
    assert_eq!(
        reopened
            .get_session("old")
            .unwrap()
            .parent_session_id
            .as_deref(),
        Some("p")
    );
    assert_eq!(
        reopened
            .get_session("other")
            .unwrap()
            .parent_session_id
            .as_deref(),
        Some("q")
    );
}

#[tokio::test]
async fn a_failed_remove_restores_the_session_and_its_children_links() {
    let dir = fresh_dir();
    let mut store = store_with(
        &dir,
        vec![
            make_child("p", "repo-1", None),
            make_child("live", "repo-1", Some("p")),
        ],
    )
    .await;

    let backup = break_next_write(&dir).await;
    let err = store.remove_session("p").await.unwrap_err();
    assert!(matches!(err, RegistryStoreError::Io(_)));
    assert!(store.get_session("p").is_some());
    assert_eq!(
        store
            .get_session("live")
            .unwrap()
            .parent_session_id
            .as_deref(),
        Some("p")
    );
    restore_write(&dir, backup).await;
}

#[tokio::test]
async fn archiving_a_parent_keeps_every_link() {
    let dir = fresh_dir();
    let mut store = store_with(
        &dir,
        vec![
            make_child("p", "repo-1", None),
            make_child("c", "repo-1", Some("p")),
        ],
    )
    .await;

    let archive = SessionPatch {
        archived_at: Some(Some("2026-01-02T00:00:00.000Z".to_string())),
        ..Default::default()
    };
    store.update_session("p", archive).await.unwrap();
    assert_eq!(
        store.get_session("c").unwrap().parent_session_id.as_deref(),
        Some("p")
    );
    let archive_child = SessionPatch {
        archived_at: Some(Some("2026-01-02T00:00:00.000Z".to_string())),
        ..Default::default()
    };
    let child = store.update_session("c", archive_child).await.unwrap();
    assert_eq!(child.parent_session_id.as_deref(), Some("p"));
}
