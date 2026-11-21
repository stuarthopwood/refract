use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tokio::sync::Notify;

use super::*;
use crate::session::agent::PendingRequest;

struct FakeHost {
    caller: String,
    store: Arc<ChecklistStore>,
    dir: tempfile::TempDir,
    approve: bool,
    asks: AtomicUsize,
    entered: Notify,
    checks: AtomicUsize,
    emitted: Arc<Notify>,
    /// `(payload, whether the Session's file was on disk when the event was emitted)`.
    emits: Arc<Mutex<Vec<(Value, bool)>>>,
}

impl Host for FakeHost {
    fn caller_id(&self) -> &str {
        &self.caller
    }
    fn store(&self) -> &Arc<ChecklistStore> {
        &self.store
    }
    async fn is_live(&self, _id: &str) -> bool {
        // The second check is the one just before the store call, so the caller is dropped after
        // the apply task exists.
        if self.checks.fetch_add(1, Ordering::SeqCst) == 1 {
            self.entered.notify_one();
        }
        true
    }
    fn is_deleting(&self, _id: &str) -> bool {
        false
    }
    async fn ask(&self, _card: PendingRequest) -> Result<(), ToolError> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        if self.approve {
            Ok(())
        } else {
            Err(ToolError::new("denied", "the developer denied this action"))
        }
    }
    fn emitter(&self) -> impl Fn(Value) + Send + 'static + use<> {
        let (emits, emitted) = (Arc::clone(&self.emits), Arc::clone(&self.emitted));
        let path = self.file_of(&self.caller);
        move |payload| {
            emits.lock().unwrap().push((payload, path.exists()));
            emitted.notify_one();
        }
    }
}

impl FakeHost {
    fn file_of(&self, id: &str) -> std::path::PathBuf {
        self.dir.path().join(format!("{id}.json"))
    }
}

fn host(approve: bool) -> Arc<FakeHost> {
    let dir = tempfile::tempdir().unwrap();
    Arc::new(FakeHost {
        caller: "s1".into(),
        store: Arc::new(ChecklistStore::new(dir.path().to_path_buf())),
        dir,
        approve,
        asks: AtomicUsize::new(0),
        entered: Notify::new(),
        checks: AtomicUsize::new(0),
        emitted: Arc::new(Notify::new()),
        emits: Arc::new(Mutex::new(Vec::new())),
    })
}

fn create_args(request_id: &str, replace: bool) -> Value {
    json!({
        "action": "create", "requestId": request_id, "title": "Plan", "replace": replace,
        "items": [{ "text": "first" }, { "text": "second", "owner": "human" }],
    })
}

async fn call(host: &FakeHost, args: Value) -> Value {
    checklist_with(host, "call-1", &args).await.unwrap()
}

/// Marks the first item as the developer's, so a replace has input to discard.
async fn adopt_first_item(host: &FakeHost) {
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    host.store
        .apply(&live, |file| {
            file.active.as_mut().unwrap().items[0].created_by = Actor::Developer;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn create_update_get_round_trip() {
    let host = host(true);
    let created = call(&host, create_args("r1", false)).await;
    assert_eq!(created["ids"], json!(["i1", "i2"]));
    let update = json!({
        "action": "update", "baseRev": created["seenRev"],
        "ops": [{ "op": "setStatus", "id": "i1", "status": "complete" }],
    });
    let updated = call(&host, update).await;
    assert_eq!(updated["rev"], json!(2));
    let got = call(
        &host,
        json!({ "action": "get", "baseRev": updated["seenRev"] }),
    )
    .await;
    assert_eq!(got["state"], json!("active"));
    assert_eq!(got["items"][0]["status"], json!("complete"));
    assert_eq!(got["items"][1]["owner"], json!("human"));
}

#[tokio::test]
async fn no_active_checklist_get_returns_none_state() {
    let host = host(true);
    assert_eq!(
        call(&host, json!({ "action": "get" })).await,
        json!({ "state": "none" })
    );
}

#[tokio::test]
async fn next_success_clears_tool_unavailable() {
    let host = host(true);
    host.store.set_tool_unavailable("s1");

    call(&host, json!({ "action": "get" })).await;

    assert!(!host.store.tool_unavailable("s1"));
}

#[tokio::test]
async fn an_op_refusal_also_clears_tool_unavailable() {
    let host = host(true);
    call(&host, create_args("r1", false)).await;
    host.store.set_tool_unavailable("s1");

    let refused = call(
        &host,
        json!({ "action": "update", "baseRev": 1, "ops": [{ "op": "setStatus", "id": "missing", "status": "complete" }] }),
    )
    .await;

    assert!(refused.get("error").is_some(), "{refused}");
    assert!(!host.store.tool_unavailable("s1"));
}

#[tokio::test]
async fn replace_card_denied_returns_denied_checklist_unchanged() {
    let host = host(false);
    call(&host, create_args("r1", false)).await;
    adopt_first_item(&host).await;

    let denied = checklist_with(&*host, "call-2", &create_args("r2", true)).await;

    assert_eq!(denied.unwrap_err().code, "denied");
    assert_eq!(host.asks.load(Ordering::SeqCst), 1);
    let got = call(&host, json!({ "action": "get" })).await;
    assert_eq!(got["rev"], json!(1));
    assert_eq!(got["items"][0]["text"], json!("first"));
}

#[tokio::test]
async fn card_not_skipped_in_yolo() {
    // The handler has no yolo path: a replace over the developer's items always asks.
    let host = host(true);
    call(&host, create_args("r1", false)).await;
    adopt_first_item(&host).await;

    let replaced = call(&host, create_args("r2", true)).await;

    assert_eq!(host.asks.load(Ordering::SeqCst), 1);
    assert_eq!(replaced["rev"], json!(1));
    assert_ne!(replaced["checklistId"], json!("c1"));
}

#[tokio::test]
async fn uses_registry_session_id_not_argument() {
    let host = host(true);
    let mut args = create_args("r1", false);
    args["sessionId"] = json!("victim");
    call(&host, args).await;
    assert!(host.file_of("s1").exists());
    assert!(!host.file_of("victim").exists());
}

#[tokio::test]
async fn cancelled_call_does_not_half_apply() {
    let host = host(true);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(
            async move { checklist_with(&*host, "call-1", &create_args("r1", false)).await },
        )
    };
    host.entered.notified().await;
    task.abort();

    // The event is sent after the write, from the store's own task, so it proves the write landed.
    tokio::time::timeout(Duration::from_secs(10), host.emitted.notified())
        .await
        .expect("the dropped call's write was announced");
    {
        let emits = host.emits.lock().unwrap();
        assert_eq!(emits.len(), 1);
        assert!(emits[0].1, "the file was on disk before the event");
        assert_eq!(emits[0].0["checklist"]["rev"], json!(1));
    }
    let got = call(&host, json!({ "action": "get" })).await;
    assert_eq!(got["state"], json!("active"));
    assert_eq!(got["itemCount"], json!(2));
}

#[tokio::test]
async fn wrong_typed_base_rev_names_base_rev() {
    let host = host(true);
    let bad = json!({ "action": "update", "baseRev": "3", "ops": [] });
    let out = call(&host, bad).await;
    assert_eq!(out["error"]["field"], json!("baseRev"));
    let not_object = call(&host, json!("nope")).await;
    assert_eq!(not_object["error"]["field"], json!("args"));
}

#[tokio::test]
async fn checklist_update_emitted_after_write_only() {
    let host = host(true);
    call(&host, create_args("r1", false)).await;
    let stale = json!({
        "action": "update", "baseRev": 0,
        "ops": [{ "op": "setStatus", "id": "nope", "status": "complete" }],
    });
    let failed = call(&host, stale).await;
    call(&host, json!({ "action": "get" })).await;

    assert!(failed["error"].is_object());
    let emits = host.emits.lock().unwrap();
    assert_eq!(emits.len(), 1);
    assert!(emits[0].1, "the file was on disk before the event");
    assert_eq!(emits[0].0["sessionId"], json!("s1"));
    assert_eq!(emits[0].0["by"], json!("agent"));
    assert_eq!(emits[0].0["opened"], json!(true));
    assert_eq!(emits[0].0["checklist"]["rev"], json!(1));
}

#[tokio::test]
async fn duplicate_update_issues_the_seen_rev_it_returns() {
    let host = host(true);
    let created = call(&host, create_args("r1", false)).await;
    let set = |value: &str, base: &Value, request_id: &str| {
        json!({
            "action": "update", "baseRev": base, "requestId": request_id,
            "ops": [{ "op": "setValue", "id": "i1", "value": value }],
        })
    };
    call(&host, set("v", &created["seenRev"], "r2")).await;
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    host.store
        .apply(&live, |file| {
            let list = file.active.as_mut().unwrap();
            let op = crate::checklist::ops::decode_op(
                &json!({ "op": "setStatus", "id": "i1", "status": "next" }),
            )
            .unwrap();
            *list = crate::checklist::developer_ops::apply_developer(list, 2, &op)?.checklist;
            Ok(())
        })
        .await
        .unwrap();

    let duplicate = call(&host, set("v", &json!(2), "r2")).await;
    assert_eq!(duplicate["duplicate"], json!(true));
    assert_eq!(duplicate["seenRev"], json!(3));
    let next = call(&host, set("w", &duplicate["seenRev"], "r3")).await;

    assert!(next["error"].is_null(), "{next}");
    assert_eq!(next["rev"], json!(4));
}
