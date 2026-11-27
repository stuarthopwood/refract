// Tests for `store::list_cache`: round trip, account scoping, missing or corrupt file, bad shapes,
// stale writes and clear.
use super::*;
use serde_json::json;

/// The epoch is process-wide, so tests that write or clear run one at a time.
static SERIAL: Mutex<()> = Mutex::const_new(());

/// A fresh, uniquely-named scratch directory under the OS temp root.
async fn scratch_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .join("scratch")
        .join("lane-1901-a")
        .join(format!("list-cache-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create scratch dir");
    dir
}

fn account(login: &str) -> CacheAccount {
    CacheAccount {
        host: "github.com".to_string(),
        login: login.to_string(),
    }
}

fn pull_requests_result() -> Value {
    json!({ "items": [{ "number": 7 }], "hasMore": false, "skipped": [], "fetchedAt": "2026-11-27T10:00:00.000Z" })
}

fn issues_result() -> Value {
    json!({ "issues": [{ "number": 9 }], "skipped": [], "fetchedAt": "2026-11-27T10:00:01.000Z" })
}

async fn put(dir: &Path, kind: ListKind, value: Value, who: &CacheAccount) {
    write(dir, kind, value, who, epoch()).await.unwrap();
}

#[tokio::test]
async fn a_missing_file_reads_as_an_empty_cache() {
    let dir = scratch_dir().await;
    let cache = read(&dir, &account("a")).await.unwrap();
    assert_eq!(cache, ListCache::default());
}

#[tokio::test]
async fn each_list_round_trips_and_writing_one_keeps_the_other() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    let me = account("a");
    put(&dir, ListKind::PullRequests, pull_requests_result(), &me).await;
    put(&dir, ListKind::Issues, issues_result(), &me).await;
    let cache = read(&dir, &me).await.unwrap();
    assert_eq!(cache.pull_requests, Some(pull_requests_result()));
    assert_eq!(cache.issues, Some(issues_result()));

    let newer = json!({ "items": [], "hasMore": false, "skipped": [], "fetchedAt": "2026-11-27T11:00:00.000Z" });
    put(&dir, ListKind::PullRequests, newer.clone(), &me).await;
    let cache = read(&dir, &me).await.unwrap();
    assert_eq!(cache.pull_requests, Some(newer));
    assert_eq!(cache.issues, Some(issues_result()));
}

#[tokio::test]
async fn rows_stored_for_another_account_read_as_nothing() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    put(&dir, ListKind::Issues, issues_result(), &account("a")).await;
    assert_eq!(
        read(&dir, &account("b")).await.unwrap(),
        ListCache::default()
    );
    let other_host = CacheAccount {
        host: "ghe.example".to_string(),
        login: "a".to_string(),
    };
    assert_eq!(read(&dir, &other_host).await.unwrap(), ListCache::default());
    assert!(read(&dir, &account("a")).await.unwrap().issues.is_some());
}

#[tokio::test]
async fn a_write_for_a_new_account_drops_the_old_accounts_other_list() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    put(&dir, ListKind::Issues, issues_result(), &account("a")).await;
    put(
        &dir,
        ListKind::PullRequests,
        pull_requests_result(),
        &account("b"),
    )
    .await;
    let cache = read(&dir, &account("b")).await.unwrap();
    assert_eq!(cache.pull_requests, Some(pull_requests_result()));
    assert_eq!(cache.issues, None);
}

#[tokio::test]
async fn a_file_without_an_account_reads_as_nothing() {
    let dir = scratch_dir().await;
    let file = json!({ "version": 1, "issues": issues_result() });
    tokio::fs::write(dir.join("listCache.json"), file.to_string())
        .await
        .unwrap();
    assert_eq!(
        read(&dir, &account("a")).await.unwrap(),
        ListCache::default()
    );
}

#[tokio::test]
async fn a_corrupt_file_reads_as_empty_and_is_quarantined() {
    let dir = scratch_dir().await;
    tokio::fs::write(dir.join("listCache.json"), b"{ not json")
        .await
        .unwrap();
    let cache = read(&dir, &account("a")).await.unwrap();
    assert_eq!(cache, ListCache::default());
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn a_section_without_the_list_shape_is_dropped_on_read() {
    let dir = scratch_dir().await;
    let file = json!({
        "version": 1,
        "account": { "host": "github.com", "login": "a" },
        "pullRequests": { "items": "oops", "skipped": [], "fetchedAt": "x" },
        "issues": issues_result()
    });
    tokio::fs::write(dir.join("listCache.json"), file.to_string())
        .await
        .unwrap();
    let cache = read(&dir, &account("a")).await.unwrap();
    assert_eq!(cache.pull_requests, None);
    assert_eq!(cache.issues, Some(issues_result()));
}

#[tokio::test]
async fn another_version_reads_as_empty() {
    let dir = scratch_dir().await;
    let file = json!({
        "version": 99,
        "account": { "host": "github.com", "login": "a" },
        "issues": issues_result()
    });
    tokio::fs::write(dir.join("listCache.json"), file.to_string())
        .await
        .unwrap();
    assert_eq!(
        read(&dir, &account("a")).await.unwrap(),
        ListCache::default()
    );
}

#[tokio::test]
async fn a_result_without_the_list_shape_is_never_written() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    put(
        &dir,
        ListKind::Issues,
        json!({ "items": [] }),
        &account("a"),
    )
    .await;
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn a_section_past_the_size_cap_is_never_written() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    let big = "x".repeat(MAX_SECTION_BYTES);
    let result = json!({ "issues": [{ "title": big }], "skipped": [], "fetchedAt": "2026-11-27T10:00:01.000Z" });
    put(&dir, ListKind::Issues, result, &account("a")).await;
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn a_write_that_began_before_a_clear_is_skipped() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    let before_fetch = epoch();
    clear(&dir).await.unwrap();
    write(
        &dir,
        ListKind::Issues,
        issues_result(),
        &account("a"),
        before_fetch,
    )
    .await
    .unwrap();
    assert!(!dir.join("listCache.json").exists());
}

#[tokio::test]
async fn an_older_result_never_overwrites_a_newer_one() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    let me = account("a");
    let older = json!({ "issues": [], "skipped": [], "fetchedAt": "2026-11-27T09:00:00.000Z" });
    put(&dir, ListKind::Issues, issues_result(), &me).await;
    put(&dir, ListKind::Issues, older, &me).await;
    let cache = read(&dir, &me).await.unwrap();
    assert_eq!(cache.issues, Some(issues_result()));
}

#[tokio::test]
async fn clear_removes_the_file_and_a_second_clear_is_fine() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    let me = account("a");
    put(&dir, ListKind::Issues, issues_result(), &me).await;
    clear(&dir).await.unwrap();
    assert!(!dir.join("listCache.json").exists());
    clear(&dir).await.unwrap();
    assert_eq!(read(&dir, &me).await.unwrap(), ListCache::default());
}

#[tokio::test]
async fn clear_removes_quarantined_and_orphaned_tmp_files_only() {
    let _serial = SERIAL.lock().await;
    let dir = scratch_dir().await;
    for name in [
        "listCache.json.corrupt-1700000000000",
        "listCache.json.4242.7.tmp",
        "unrelated.json",
        "unrelated.json.corrupt-1",
        "unrelated.json.4242.7.tmp",
    ] {
        tokio::fs::write(dir.join(name), b"x").await.unwrap();
    }
    clear(&dir).await.unwrap();
    assert!(!dir.join("listCache.json.corrupt-1700000000000").exists());
    assert!(!dir.join("listCache.json.4242.7.tmp").exists());
    assert!(dir.join("unrelated.json").exists());
    assert!(dir.join("unrelated.json.corrupt-1").exists());
    assert!(dir.join("unrelated.json.4242.7.tmp").exists());
}
