use std::sync::Mutex;

use super::*;
use crate::checklist::model::Actor;
use crate::checklist::test_support::{checklist, item};

struct FakeHost {
    store: Arc<ChecklistStore>,
    dir: tempfile::TempDir,
    live: bool,
    entered: tokio::sync::Notify,
    emitted: Arc<tokio::sync::Notify>,
    /// `(payload, whether the Session's file was on disk when the event was emitted)`.
    emits: Arc<Mutex<Vec<(Value, bool)>>>,
}

impl Host for FakeHost {
    fn store(&self) -> &Arc<ChecklistStore> {
        &self.store
    }
    async fn is_live(&self, _id: &str) -> bool {
        self.entered.notify_one();
        self.live
    }
    fn is_deleting(&self, _id: &str) -> bool {
        false
    }
    fn emitter(&self) -> impl Fn(Value) + Send + 'static + use<> {
        let (emits, emitted) = (Arc::clone(&self.emits), Arc::clone(&self.emitted));
        let path = self.dir.path().join("s1.json");
        move |payload| {
            let written = std::fs::read_to_string(&path).is_ok_and(|t| t.contains("\"complete\""));
            emits.lock().unwrap().push((payload, written));
            emitted.notify_one();
        }
    }
}

fn host(live: bool) -> FakeHost {
    let dir = tempfile::tempdir().unwrap();
    FakeHost {
        store: Arc::new(ChecklistStore::new(dir.path().to_path_buf())),
        dir,
        live,
        entered: tokio::sync::Notify::new(),
        emitted: Arc::new(tokio::sync::Notify::new()),
        emits: Arc::new(Mutex::new(Vec::new())),
    }
}

async fn seed(host: &FakeHost) {
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    host.store
        .apply(&live, |file| {
            file.active = Some(checklist(vec![item("i1")]));
            Ok(())
        })
        .await
        .unwrap();
}

fn tick() -> Value {
    json!({ "op": "setStatus", "id": "i1", "status": "complete" })
}

#[tokio::test]
async fn get_returns_null_without_checklist() {
    let host = host(true);
    assert_eq!(get_with(&host, "s1").await.unwrap(), Value::Null);
    seed(&host).await;
    assert_eq!(get_with(&host, "s1").await.unwrap()["id"], json!("p1"));
}

#[tokio::test]
async fn mutate_ticks_and_emits_by_developer() {
    let host = host(true);
    seed(&host).await;
    let out = mutate_with(&host, "s1", "p1", 1, None, &tick())
        .await
        .unwrap();
    assert_eq!(out["items"][0]["status"], json!("complete"));
    assert_eq!(out["items"][0]["completedBy"], json!("developer"));
    let emits = host.emits.lock().unwrap();
    assert_eq!(emits.len(), 1);
    let (payload, written) = &emits[0];
    assert!(written);
    assert_eq!(payload["by"], json!("developer"));
    assert_eq!(payload["checklist"], out);
    assert!(payload.get("opened").is_none());
}

#[tokio::test]
async fn mutate_item_changed_returns_current_checklist() {
    let host = host(true);
    seed(&host).await;
    let out = mutate_with(&host, "s1", "p1", 0, None, &tick())
        .await
        .unwrap();
    assert_eq!(out["error"]["code"], json!("item_changed"));
    assert_eq!(out["checklist"]["items"][0]["status"], json!("upcoming"));
    assert_eq!(
        out["checklist"]["items"][0]["updatedBy"],
        json!(Actor::Agent)
    );
    assert!(host.emits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unknown_session_not_found() {
    let host = host(false);
    let got = get_with(&host, "s1").await.unwrap_err();
    let mutated = mutate_with(&host, "s1", "p1", 1, None, &tick())
        .await
        .unwrap_err();
    assert_eq!((got.code, mutated.code), ("not-found", "not-found"));
    assert!(!host.dir.path().join("s1.json").exists());
    assert!(host.emits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mutate_accepts_request_id() {
    let host = host(true);
    seed(&host).await;
    let id = Some("r1".to_string());
    let first = mutate_with(&host, "s1", "p1", 1, id.clone(), &tick())
        .await
        .unwrap();
    let again = mutate_with(&host, "s1", "p1", 1, id, &tick())
        .await
        .unwrap();
    assert_eq!(
        (first["rev"].clone(), again["rev"].clone()),
        (json!(2), json!(2))
    );
    assert_eq!(host.emits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn dropped_mutate_still_emits_after_its_write_lands() {
    let host = Arc::new(host(true));
    seed(&host).await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { mutate_with(&*host, "s1", "p1", 1, None, &tick()).await })
    };
    host.entered.notified().await;
    task.abort();

    tokio::time::timeout(std::time::Duration::from_secs(10), host.emitted.notified())
        .await
        .expect("the dropped call's write was announced");
    let emits = host.emits.lock().unwrap();
    assert_eq!(emits.len(), 1);
    assert!(emits[0].1, "the file was on disk before the event");
}

#[tokio::test]
async fn mutate_refuses_an_empty_or_oversized_request_id() {
    let host = host(true);
    seed(&host).await;
    for bad in [String::new(), "x".repeat(65)] {
        let out = mutate_with(&host, "s1", "p1", 1, Some(bad), &tick())
            .await
            .unwrap();
        assert!(out["error"].is_object(), "{out}");
        assert_eq!(out["checklist"]["items"][0]["status"], json!("upcoming"));
    }
    assert!(host.emits.lock().unwrap().is_empty());
}
