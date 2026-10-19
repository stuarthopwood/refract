// Test module for `registry.rs`, split into this sibling file to stay under the 600-line
// soft cap (`pnpm check:file-size`) -- included via `#[path = "registry_tests.rs"] mod tests;`
// in `registry.rs` itself, so this is still logically `store::registry::tests`.
//
// Port of `src/main/store/registry.test.ts` (issue #480/#510 quality-gate coverage). Scratch
// dirs are left in the OS temp folder (never removed), the same deliberate choice the TS
// file's own header makes under the destructive-delete guard.
//
// The TS suite's two `vi.mock`-based "does not clobber a faster concurrent call" race tests
// are not ported: they exist to prove a single-threaded JS event loop can interleave two
// `async` calls sharing one mutable `RegistryStore` object between an await point and its
// resolution. Every mutator here takes `&mut self`, so the borrow checker already makes that
// interleaving impossible -- two calls can never both hold a live `&mut RegistryStore` at
// once, with or without a test for it.

use super::*;

fn fresh_dir() -> PathBuf {
    std::env::temp_dir().join(format!("refract-registry-test-{}", uuid::Uuid::new_v4()))
}

fn make_repository(id: &str, path: &str) -> Repository {
    Repository {
        id: id.to_string(),
        path: path.to_string(),
        name: "pinion".to_string(),
        default_branch: "main".to_string(),
        added_at: "2026-01-01T00:00:00.000Z".to_string(),
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
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
    }
}

/// Forces the NEXT write to `dir/registry.json` to fail with a real I/O error (no mocking
/// framework in this build): swaps the file for a same-named directory, so
/// `write_json_file`'s own final `tokio::fs::rename(tmp, file)` cannot rename a file onto an
/// existing directory (`EPERM` on Windows, confirmed empirically). Returns the pre-failure
/// bytes so the caller can restore them with `restore_write` once the rollback assertion is
/// done.
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

/// Undoes `break_next_write`: removes the stand-in directory (still empty -- the write
/// attempt in between only ever touched a differently-named `.tmp` sibling) and restores the
/// pre-failure bytes, so a later `RegistryStore::open`/write sees a real file again.
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
