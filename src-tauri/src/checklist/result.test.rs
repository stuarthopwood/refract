use serde_json::json;

use super::*;
use crate::agent_tools::MAX_RESULT_BYTES;
use crate::checklist::changes::user_changes;
use crate::checklist::developer_ops::apply_developer;
use crate::checklist::model::{Actor, ItemOwner, ItemStatus, LastDeveloperOp, OpKind};
use crate::checklist::test_support::{checklist, item, op};

/// Every byte of a worst-case item: maximum keys and flags, a four-digit rev, and 60 bytes of
/// quotes, which JSON escapes to 120.
fn worst_item(n: usize) -> ChecklistItem {
    let mut it = item(&format!("i{n}"));
    it.text = "\"".repeat(200);
    it.status = ItemStatus::InProgress;
    it.owner = ItemOwner::Either;
    it.requires_value = true;
    it.value = Some("v".repeat(1024));
    it.value_by = Some(Actor::Developer);
    it.rev = 9999;
    it.updated_by = Actor::Developer;
    it.edited_by_developer = true;
    it
}

fn worst_list(count: usize) -> Checklist {
    let mut list = checklist((1..=count).map(worst_item).collect());
    list.title = "\"".repeat(120);
    list.rev = 9999;
    list
}

fn worst_changes(list: &mut Checklist) -> ChangeSet {
    for it in &mut list.items {
        it.last_developer_ops = vec![LastDeveloperOp {
            kind: OpKind::Edit,
            rev: 9000,
            fields: vec!["text".into(), "group".into()],
        }];
    }
    user_changes(list)
}

fn size(value: &Value) -> usize {
    value.to_string().len()
}

fn result_for(list: &Checklist, changes: &ChangeSet) -> Value {
    let ids: Vec<String> = list.items.iter().map(|i| i.id.clone()).collect();
    build_result(&ResultInput {
        list,
        duplicate: false,
        assigned: Some(("ids", &ids)),
        items: list.items.iter().collect(),
        full: false,
        changes,
    })
}

#[test]
fn item_text_cut_to_60_bytes_with_truncated_flag() {
    let mut long = item("i1");
    long.text = format!("{}é", "a".repeat(59));
    let out = compact_item(&long);
    assert_eq!(out["text"], "a".repeat(59));
    assert_eq!(out["textTruncated"], true);

    let mut exact = item("i2");
    exact.text = "b".repeat(60);
    let out = compact_item(&exact);
    assert_eq!(out["text"].as_str().unwrap().len(), 60);
    assert!(out.get("textTruncated").is_none());
}

#[test]
fn values_never_inlined() {
    let mut it = item("i1");
    it.value = Some("hunter2".into());
    let compact = compact_item(&it);
    assert_eq!(
        (compact["hasValue"].clone(), compact["valueBytes"].clone()),
        (json!(true), json!(7))
    );
    assert!(!compact.to_string().contains("hunter2"));

    let list = checklist(vec![it]);
    let set = user_changes(&list);
    assert!(!result_for(&list, &set).to_string().contains("hunter2"));
    assert_eq!(compact_item(&item("i2"))["hasValue"], false);
}

#[test]
fn items_budget_3948() {
    let list = worst_list(40);
    let items: Vec<&ChecklistItem> = list.items.iter().collect();
    let (page, more) = items_page(&items, false);
    assert!(more);
    let used: usize = page.iter().map(size).sum::<usize>() + page.len() - 1;
    assert!(used <= ITEMS_BUDGET_BYTES, "{used}");
    // One more item would not have fit.
    assert!(used + 1 + size(&compact_item(&list.items[page.len()])) > ITEMS_BUDGET_BYTES);

    // A full item always fits, so a full page is never empty.
    let (full, _) = items_page(&items, true);
    assert!(!full.is_empty());
    assert!(full[0].get("lastDeveloperOps").is_none());
    assert_eq!(full[0]["value"].as_str().unwrap().len(), 1024);
}

#[test]
fn create_40_items_lists_all_ids_and_first_11_items() {
    let list = worst_list(40);
    let out = result_for(&list, &user_changes(&list));
    assert_eq!(out["ids"].as_array().unwrap().len(), 40);
    assert_eq!(out["items"].as_array().unwrap().len(), 11);
    assert_eq!(out["moreItems"], true);
    assert_eq!(out["itemCount"], 40);
}

#[test]
fn worst_case_result_at_most_7168() {
    let mut list = worst_list(40);
    let changes = worst_changes(&mut list);
    assert_eq!(changes.changes.len(), 20);
    assert!(changes.more);
    let out = result_for(&list, &changes);
    assert!(size(&out) <= RESULT_BUDGET_BYTES, "{}", size(&out));
    assert_eq!(out["userChanges"].as_array().unwrap().len(), 20);
}

#[test]
fn worst_case_error_header_plus_items_under_4069() {
    let list = worst_list(40);
    for code in ErrorCode::ALL {
        let mut err = ChecklistError::field(code, "agentCompletable");
        err.item_ids = list.items.iter().map(|i| i.id.clone()).collect();
        let out = error_payload(&err, Some(&list));
        assert!(size(&out) <= 4069, "{code:?} {}", size(&out));
        assert!(message(code).len() <= MAX_MESSAGE_BYTES, "{code:?}");
    }
}

#[test]
fn worst_case_under_max_result_bytes() {
    let mut list = worst_list(40);
    let changes = worst_changes(&mut list);
    assert!(size(&result_for(&list, &changes)) < MAX_RESULT_BYTES);
    let err = ChecklistError::new(ErrorCode::Conflict);
    assert!(size(&error_payload(&err, Some(&list))) < MAX_RESULT_BYTES);
}

#[test]
fn conflict_lists_items_within_budget() {
    let list = worst_list(40);
    let ids: Vec<String> = list.items.iter().map(|i| i.id.clone()).collect();
    let out = error_payload(
        &ChecklistError::items(ErrorCode::Conflict, ids),
        Some(&list),
    );
    assert_eq!(out["error"]["code"], "conflict");
    assert_eq!(out["items"].as_array().unwrap().len(), 11);
    assert_eq!(out["moreItems"], true);

    // Only the conflicting items are listed when they are few.
    let few = error_payload(
        &ChecklistError::item(ErrorCode::Conflict, "i7"),
        Some(&list),
    );
    assert_eq!(few["items"].as_array().unwrap().len(), 1);
    assert_eq!(few["items"][0]["id"], "i7");
    assert_eq!(few["moreItems"], false);
}

#[test]
fn item_removed_vs_unknown_item() {
    let mut list = checklist(vec![item("i1"), item("i2")]);
    let applied =
        apply_developer(&list, list.rev, &op(json!({"op": "remove", "id": "i2"}))).unwrap();
    list = applied.checklist;
    let removed = crate::checklist::ops::find(&list, "i2").unwrap_err();
    let unknown = crate::checklist::ops::find(&list, "i99").unwrap_err();

    let a = error_payload(&removed, Some(&list));
    let b = error_payload(&unknown, Some(&list));
    assert_eq!(a["error"]["code"], "item_removed");
    assert_eq!(b["error"]["code"], "unknown_item");
    assert_ne!(a["error"]["message"], b["error"]["message"]);
    // Neither names an item that exists, so both list the checklist for re-planning.
    assert_eq!(a["items"].as_array().unwrap().len(), 1);
    assert_eq!(b["items"][0]["id"], "i1");
    assert_eq!(error_payload(&removed, None).get("items"), None);
}

#[test]
fn not_agent_completable_has_a_message() {
    let text = message(ErrorCode::NotAgentCompletable);
    assert!(text.contains("complete"));
    assert!(text.len() <= MAX_MESSAGE_BYTES);
    let out = error_payload(
        &ChecklistError::item(ErrorCode::NotAgentCompletable, "i1"),
        None,
    );
    assert_eq!(out["error"]["code"], "not_agent_completable");
    assert_eq!(out["error"]["message"], text);
}
