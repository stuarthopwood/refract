use std::sync::{Arc, Mutex};

use super::*;
use crate::checklist::model::{Checklist, ChecklistFile, ItemStatus};
use crate::checklist::records::has_send_record;
use crate::checklist::store::{ChecklistStore, LiveSession};
use crate::checklist::test_support::{checklist, developer_item, item};

struct FakeHost {
    store: Arc<ChecklistStore>,
    _dir: tempfile::TempDir,
    agent: bool,
    reply: Mutex<Result<MessageDelivery, &'static str>>,
    /// The checklist file as it was when `deliver` ran, to prove store-before-send.
    seen_at_send: Mutex<Option<ChecklistFile>>,
    emits: Arc<Mutex<Vec<Value>>>,
}

impl Host for FakeHost {
    fn store(&self) -> &Arc<ChecklistStore> {
        &self.store
    }
    async fn is_live(&self, _id: &str) -> bool {
        true
    }
    fn is_deleting(&self, _id: &str) -> bool {
        false
    }
    fn emitter(&self) -> impl Fn(Value) + Send + 'static + use<> {
        let emits = Arc::clone(&self.emits);
        move |payload| emits.lock().unwrap().push(payload)
    }
}

impl ItemHost for FakeHost {
    fn has_agent(&self, _id: &str) -> bool {
        self.agent
    }
    async fn deliver(&self, id: &str, _text: String) -> Result<MessageDelivery, AgentError> {
        let live = LiveSession::check(id, |_| true, |_| false).unwrap();
        let file = self.store.read(&live, Clone::clone).await.unwrap();
        *self.seen_at_send.lock().unwrap() = Some(file);
        self.reply
            .lock()
            .unwrap()
            .map_err(|code| AgentError::new(code, "refused"))
    }
}

fn host(agent: bool, reply: Result<MessageDelivery, &'static str>) -> FakeHost {
    let dir = tempfile::tempdir().unwrap();
    FakeHost {
        store: Arc::new(ChecklistStore::new(dir.path().to_path_buf())),
        _dir: dir,
        agent,
        reply: Mutex::new(reply),
        seen_at_send: Mutex::new(None),
        emits: Arc::new(Mutex::new(Vec::new())),
    }
}

async fn seed(host: &FakeHost, list: Checklist) {
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    host.store
        .apply(&live, |file| {
            file.active = Some(list);
            Ok(())
        })
        .await
        .unwrap();
}

async fn file(host: &FakeHost) -> ChecklistFile {
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    host.store.read(&live, Clone::clone).await.unwrap()
}

fn status_of(file: &ChecklistFile) -> ItemStatus {
    file.active.as_ref().unwrap().items[0].status
}

async fn send(host: &FakeHost, action: SendAction, text: Option<&str>) -> Value {
    item_message_with(host, "s1", "p1", "i1", 1, action, text.map(str::to_string))
        .await
        .unwrap()
}

fn one_developer_item() -> Checklist {
    let mut it = item("i1");
    it.requires_value = true;
    it.value = Some("42".into());
    it.value_by = Some(Actor::Developer);
    checklist(vec![it])
}

#[tokio::test]
async fn no_live_agent_ask_and_complete_fail_agent_not_running() {
    let host = host(false, Ok(MessageDelivery::Sent));
    seed(&host, one_developer_item()).await;
    for action in [SendAction::Ask, SendAction::Complete] {
        let err = item_message_with(&host, "s1", "p1", "i1", 1, action, Some("why".into()))
            .await
            .unwrap_err();
        assert_eq!(err.code, "agent-not-running");
    }
    assert!(host.seen_at_send.lock().unwrap().is_none());
}

#[tokio::test]
async fn value_with_no_agent_is_refused_here_and_stored_via_mutate() {
    let host = host(false, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![developer_item("i1")])).await;
    let err = item_message_with(
        &host,
        "s1",
        "p1",
        "i1",
        1,
        SendAction::Value,
        Some("7".into()),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "agent-not-running");
    assert_eq!(file(&host).await.active.unwrap().items[0].value, None);

    let op = json!({ "op": "setValue", "id": "i1", "value": "7" });
    let stored = crate::ipc::checklist::mutate_with(&host, "s1", "p1", 1, None, &op)
        .await
        .unwrap();
    assert_eq!(stored["items"][0]["value"], json!("7"));
}

#[tokio::test]
async fn state_and_record_stored_before_send() {
    let host = host(true, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![developer_item("i1")])).await;
    let out = send(&host, SendAction::Value, Some("7")).await;
    let seen = host.seen_at_send.lock().unwrap().clone().unwrap();
    let list = seen.active.as_ref().unwrap();
    assert_eq!(list.items[0].value.as_deref(), Some("7"));
    assert_eq!(seen.send_records.len(), 1);
    assert_eq!(out["checklist"]["items"][0]["value"], json!("7"));
}

#[tokio::test]
async fn refused_send_undoes_complete_and_removes_record() {
    let host = host(true, Err("agent-not-running"));
    seed(&host, one_developer_item()).await;
    let err = item_message_with(&host, "s1", "p1", "i1", 1, SendAction::Complete, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "prompt-failed");
    let after = file(&host).await;
    assert_eq!(status_of(&after), ItemStatus::Upcoming);
    assert!(after.send_records.is_empty());
    assert!(after.pending_complete.is_empty());
    let sent = host.seen_at_send.lock().unwrap().clone().unwrap();
    assert_eq!(status_of(&sent), ItemStatus::InProgress);
    assert_eq!(host.emits.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn refused_send_after_value_keeps_the_value() {
    let host = host(true, Err("agent-not-running"));
    seed(&host, checklist(vec![developer_item("i1")])).await;
    item_message_with(
        &host,
        "s1",
        "p1",
        "i1",
        1,
        SendAction::Value,
        Some("7".into()),
    )
    .await
    .unwrap_err();
    let after = file(&host).await;
    assert_eq!(
        after.active.as_ref().unwrap().items[0].value.as_deref(),
        Some("7")
    );
    assert!(after.send_records.is_empty());
}

#[tokio::test]
async fn returns_sent_queued_held() {
    for (delivery, name) in [
        (MessageDelivery::Sent, "sent"),
        (MessageDelivery::Queued, "queued"),
        (MessageDelivery::Held, "held"),
    ] {
        let host = host(true, Ok(delivery));
        seed(&host, checklist(vec![item("i1")])).await;
        let out = send(&host, SendAction::Ask, Some("why")).await;
        assert_eq!(out["delivery"], json!(name));
        assert!(has_send_record_for_ask(&file(&host).await, &host).await);
    }
}

#[tokio::test]
async fn only_a_delivery_failure_reports_prompt_failed() {
    let host = host(true, Err("agent-not-running"));
    seed(&host, one_developer_item()).await;
    let err = item_message_with(&host, "s1", "p1", "i1", 1, SendAction::Complete, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "prompt-failed");

    let no_agent = self::host(false, Ok(MessageDelivery::Sent));
    seed(&no_agent, one_developer_item()).await;
    let err = item_message_with(&no_agent, "s1", "p1", "i1", 1, SendAction::Complete, None)
        .await
        .unwrap_err();
    assert_ne!(err.code, "prompt-failed");
}

async fn has_send_record_for_ask(file: &ChecklistFile, _host: &FakeHost) -> bool {
    let record = &file.send_records[0];
    has_send_record(
        file,
        &record.checklist_id,
        &record.item_id,
        record.rev,
        SendAction::Ask,
        &crate::agent_tools::checklist_envelope::wrap(
            "p1",
            "i1",
            record.rev,
            SendAction::Ask,
            "why",
        ),
    )
}

#[tokio::test]
async fn engine_refusal_returns_error_and_checklist() {
    let host = host(true, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![item("i1")])).await;
    let out = send(&host, SendAction::Ask, Some("   ")).await;
    assert_eq!(out["error"]["code"], json!("invalid_input"));
    assert_eq!(out["checklist"]["id"], json!("p1"));
    assert!(host.seen_at_send.lock().unwrap().is_none());
    assert!(file(&host).await.send_records.is_empty());
}

#[tokio::test]
async fn emits_checklist_update_with_developer_actor() {
    let host = host(true, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![developer_item("i1")])).await;
    send(&host, SendAction::Value, Some("7")).await;
    let emits = host.emits.lock().unwrap();
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0]["by"], json!("developer"));
}

#[tokio::test]
async fn ask_emits_nothing_because_nothing_changed() {
    let host = host(true, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![item("i1")])).await;
    send(&host, SendAction::Ask, Some("why")).await;
    assert!(host.emits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn clear_resolved_runs_after_each_op_kind() {
    use crate::checklist::model::PendingComplete;
    let host = host(true, Ok(MessageDelivery::Sent));
    seed(&host, checklist(vec![item("i1")])).await;
    let live = LiveSession::check("s1", |_| true, |_| false).unwrap();
    // The item is still upcoming, so this entry is already resolved.
    host.store
        .apply(&live, |file| {
            file.pending_complete.push(PendingComplete {
                checklist_id: "p1".into(),
                item_id: "i1".into(),
                turn_marker: 1,
                started: false,
            });
            Ok(())
        })
        .await
        .unwrap();

    send(&host, SendAction::Ask, Some("why")).await;

    assert!(file(&host).await.pending_complete.is_empty());
}

#[test]
fn action_names_map_to_their_actions_and_unknown_is_none() {
    assert_eq!(action_of("ask"), Some(SendAction::Ask));
    assert_eq!(action_of("value"), Some(SendAction::Value));
    assert_eq!(action_of("complete"), Some(SendAction::Complete));
    assert_eq!(action_of("Complete"), None);
    assert_eq!(action_of(""), None);
}
