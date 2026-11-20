use serde_json::json;

use super::*;
use crate::checklist::agent_ops::apply_agent;
use crate::checklist::developer_ops::apply_developer;
use crate::checklist::model::ChecklistItem;
use crate::checklist::test_support::{checklist, get, item, op};

fn add(file: &mut ChecklistFile, n: u64) {
    add_send_record(
        file,
        "p1",
        &format!("i{n}"),
        n,
        SendAction::Complete,
        "do it",
    );
}

#[test]
fn add_501st_evicts_oldest() {
    let mut file = ChecklistFile::empty();
    for n in 1..=501 {
        add(&mut file, n);
    }

    assert_eq!(file.send_records.len(), 500);
    assert_eq!(file.send_records[0].item_id, "i2");
    assert_eq!(file.send_records[499].item_id, "i501");
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        1,
        SendAction::Complete,
        "do it"
    ));
    assert!(has_send_record(
        &file,
        "p1",
        "i2",
        2,
        SendAction::Complete,
        "do it"
    ));
}

#[test]
fn lookup_matches_all_five_fields() {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "p1", "i1", 7, SendAction::Ask, "question");

    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Ask,
        "question"
    ));
}

#[test]
fn one_field_differs_no_match() {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "p1", "i1", 7, SendAction::Ask, "question");

    assert!(!has_send_record(
        &file,
        "p2",
        "i1",
        7,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i2",
        7,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        8,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Value,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Ask,
        "question?"
    ));
}

#[test]
fn record_stores_hash_not_text() {
    let mut file = ChecklistFile::empty();
    add_send_record(
        &mut file,
        "p1",
        "i1",
        1,
        SendAction::Value,
        "secret turn text",
    );

    let stored = serde_json::to_string(&file.send_records).unwrap();
    assert!(!stored.contains("secret"));
    assert_eq!(file.send_records[0].text_hash.len(), 64);
    assert_eq!(
        file.send_records[0].text_hash,
        text_hash("secret turn text")
    );
}

#[test]
fn text_hash_stable_known_vector() {
    assert_eq!(
        text_hash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

fn file_with(items: Vec<ChecklistItem>) -> ChecklistFile {
    let mut file = ChecklistFile::empty();
    file.active = Some(checklist(items));
    file
}

fn item_of<'a>(file: &'a ChecklistFile, id: &str) -> &'a ChecklistItem {
    get(file.active.as_ref().unwrap(), id)
}

fn accepted(status: ItemStatus) -> (ChecklistFile, u64) {
    let mut it = item("i1");
    it.status = status;
    let mut file = file_with(vec![it]);
    let (marker, _) = accept_complete(&mut file, "i1", |_| "do it".to_string()).unwrap();
    (file, marker)
}

fn agent(file: &mut ChecklistFile, value: serde_json::Value) {
    let mut list = file.active.clone().unwrap();
    // The agent has read every rev so far, so its `baseRev` is not clamped below an item's rev.
    list.issued_seen_rev = list.rev;
    file.active = Some(
        apply_agent(&list, list.rev, &[op(value)])
            .unwrap()
            .checklist,
    );
}

fn developer(file: &mut ChecklistFile, value: serde_json::Value) {
    let list = file.active.as_ref().unwrap();
    file.active = Some(
        apply_developer(list, list.rev, &op(value))
            .unwrap()
            .checklist,
    );
}

fn set_status(id: &str, status: &str) -> serde_json::Value {
    json!({"op": "setStatus", "id": id, "status": status})
}

#[test]
fn accept_one_entry() {
    let (mut file, marker) = accepted(ItemStatus::Upcoming);

    let it = item_of(&file, "i1");
    assert_eq!(it.status, ItemStatus::InProgress);
    assert_eq!(it.previous_status, Some(ItemStatus::Upcoming));
    assert_eq!(it.status_rev, marker);
    assert_eq!(file.active.as_ref().unwrap().rev, marker);
    assert_eq!(
        file.pending_complete,
        vec![PendingComplete {
            checklist_id: "p1".into(),
            item_id: "i1".into(),
            turn_marker: marker,
            started: false,
        }]
    );
    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        marker,
        SendAction::Complete,
        "do it"
    ));
    assert_eq!(
        accept_complete(&mut file, "i1", |_| "again".to_string()),
        None
    );
    assert_eq!(file.pending_complete.len(), 1);
}

#[test]
fn accept_complete_hashes_the_text_it_returns() {
    let mut file = file_with(vec![item("i1")]);

    let (marker, text) = accept_complete(&mut file, "i1", |rev| format!("turn at {rev}")).unwrap();

    assert_eq!(text, format!("turn at {marker}"));
    assert!(has_send_record(&file, "p1", "i1", marker, SendAction::Complete, &text));
    assert!(!has_send_record(&file, "p1", "i1", marker, SendAction::Complete, "turn at 0"));
    assert_eq!(file.send_records.last().unwrap().text_hash, text_hash(&text));
}

#[test]
fn accept_complete_envelope_carries_the_new_rev() {
    let mut file = file_with(vec![item("i1")]);
    let before = file.active.as_ref().unwrap().rev;

    let (marker, text) = accept_complete(&mut file, "i1", |rev| {
        crate::agent_tools::checklist_envelope::wrap("p1", "i1", rev, SendAction::Complete, "b")
    })
    .unwrap();

    assert_eq!(marker, before + 1);
    let parsed = crate::agent_tools::checklist_envelope::parse(&text).unwrap();
    assert_eq!(parsed.rev, marker);
    assert_eq!(parsed.rev, item_of(&file, "i1").status_rev);
}

#[test]
fn refused_accept_never_builds_the_text() {
    let mut file = file_with(vec![item("i1")]);
    accept_complete(&mut file, "i1", |_| "first".to_string()).unwrap();

    let second = accept_complete(&mut file, "i1", |_| panic!("builder must not run"));

    assert_eq!(second, None);
}

#[test]
fn refused_send_restores_previous_status() {
    let (mut file, marker) = accepted(ItemStatus::Next);

    assert!(refuse_complete(&mut file, "i1"));

    assert_eq!(item_of(&file, "i1").status, ItemStatus::Next);
    assert_eq!(item_of(&file, "i1").previous_status, None);
    assert!(file.pending_complete.is_empty());
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        marker,
        SendAction::Complete,
        "do it"
    ));
}

#[test]
fn entry_cleared_on_agent_setstatus_developer_status_edit_remove_replace() {
    type Change = Box<dyn Fn(&mut ChecklistFile)>;
    let cases: Vec<(&str, Change)> = vec![
        (
            "agent setStatus",
            Box::new(|f| agent(f, set_status("i1", "blocked"))),
        ),
        (
            "developer status",
            Box::new(|f| developer(f, set_status("i1", "complete"))),
        ),
        (
            "developer edit",
            Box::new(|f| developer(f, json!({"op": "edit", "id": "i1", "text": "mine"}))),
        ),
        (
            "developer remove",
            Box::new(|f| developer(f, json!({"op": "remove", "id": "i1"}))),
        ),
        (
            "replace",
            Box::new(|f| {
                let mut list = checklist(vec![item("i1")]);
                list.id = "p2".into();
                f.active = Some(list);
            }),
        ),
    ];
    for (name, change) in cases {
        let (mut file, _) = accepted(ItemStatus::Upcoming);
        change(&mut file);
        assert!(clear_resolved(&mut file), "{name}");
        assert!(file.pending_complete.is_empty(), "{name}");
    }

    let (mut file, _) = accepted(ItemStatus::Upcoming);
    agent(
        &mut file,
        json!({"op": "setValue", "id": "i1", "value": "v"}),
    );
    assert!(!clear_resolved(&mut file));
    assert_eq!(file.pending_complete.len(), 1);
}

#[test]
fn settle_restores_when_still_in_progress_same_status_rev() {
    let (mut file, marker) = accepted(ItemStatus::Next);
    assert!(start_entry(&mut file, "p1", "i1", marker));
    // A value-only change moves `rev` but not `statusRev`.
    agent(
        &mut file,
        json!({"op": "setValue", "id": "i1", "value": "v"}),
    );

    assert!(settle_started(&mut file));

    assert_eq!(item_of(&file, "i1").status, ItemStatus::Next);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn settle_noop_when_status_or_status_rev_changed() {
    let (mut file, marker) = accepted(ItemStatus::Next);
    start_entry(&mut file, "p1", "i1", marker);
    agent(&mut file, set_status("i1", "blocked"));
    settle_started(&mut file);
    assert_eq!(item_of(&file, "i1").status, ItemStatus::Blocked);
    assert!(file.pending_complete.is_empty());

    // Same status again, but a later `statusRev`: someone re-set it, so it is theirs.
    let (mut file, marker) = accepted(ItemStatus::Next);
    start_entry(&mut file, "p1", "i1", marker);
    agent(&mut file, set_status("i1", "in_progress"));
    settle_started(&mut file);
    assert_eq!(item_of(&file, "i1").status, ItemStatus::InProgress);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn stop_restores() {
    let (mut file, _) = accepted(ItemStatus::Next);

    assert!(!settle_started(&mut file), "queued turn survives a settle");
    assert_eq!(file.pending_complete.len(), 1);
    assert!(settle_unstarted(&mut file));

    assert_eq!(item_of(&file, "i1").status, ItemStatus::Next);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn stale_entry_on_load_cleared_by_same_rule() {
    let (mut file, marker) = accepted(ItemStatus::Next);
    start_entry(&mut file, "p1", "i1", marker);
    let mut second = item("i2");
    second.status = ItemStatus::Next;
    file.active.as_mut().unwrap().items.push(second);
    accept_complete(&mut file, "i2", |_| "x".to_string()).unwrap();
    agent(&mut file, set_status("i2", "blocked"));

    assert!(settle_all(&mut file));

    assert_eq!(item_of(&file, "i1").status, ItemStatus::Next);
    assert_eq!(item_of(&file, "i2").status, ItemStatus::Blocked);
    assert!(file.pending_complete.is_empty());
}
