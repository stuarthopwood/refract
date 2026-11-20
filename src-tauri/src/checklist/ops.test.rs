use serde_json::{json, Value};

use super::*;
use crate::checklist::test_support::{checklist, completed, item};

fn invalid(field: &'static str) -> ChecklistError {
    ChecklistError::field(ErrorCode::InvalidInput, field)
}

#[test]
fn tick_stores_previous_status() {
    let mut it = item("i1");
    it.status = ItemStatus::InProgress;
    set_status(&mut it, ItemStatus::Complete, 5, Actor::Developer);
    assert_eq!(it.status, ItemStatus::Complete);
    assert_eq!(it.previous_status, Some(ItemStatus::InProgress));
    assert_eq!(it.completed_by, Some(Actor::Developer));
    assert_eq!(it.updated_by, Actor::Developer);
}

#[test]
fn untick_restores_or_upcoming() {
    let mut it = completed("i1", Actor::Developer);
    it.previous_status = Some(ItemStatus::Next);
    set_status(&mut it, ItemStatus::Upcoming, 6, Actor::Developer);
    assert_eq!(it.status, ItemStatus::Next);
    assert_eq!(it.previous_status, None);
    assert_eq!(it.completed_by, None);

    let mut bare = completed("i2", Actor::Developer);
    bare.previous_status = None;
    set_status(&mut bare, ItemStatus::Blocked, 6, Actor::Developer);
    assert_eq!(bare.status, ItemStatus::Upcoming);
}

#[test]
fn non_complete_move_keeps_previous_status() {
    let mut it = item("i1");
    it.status = ItemStatus::Next;
    it.previous_status = Some(ItemStatus::Blocked);
    set_status(&mut it, ItemStatus::InProgress, 3, Actor::Agent);
    assert_eq!(it.status, ItemStatus::InProgress);
    assert_eq!(it.previous_status, Some(ItemStatus::Blocked));
}

#[test]
fn status_rev_is_checklist_rev() {
    let mut list = checklist(vec![item("i1")]);
    let rev = bump_rev(&mut list);
    assert_eq!(rev, 2);
    set_status(&mut list.items[0], ItemStatus::Next, rev, Actor::Agent);
    assert_eq!(list.items[0].status_rev, list.rev);

    // A text change stamps `rev` but is not a status change.
    let rev = bump_rev(&mut list);
    edit_item(&mut list.items[0], Some("new"), None, rev, Actor::Agent).unwrap();
    assert_eq!(list.items[0].rev, 3);
    assert_eq!(list.items[0].status_rev, 2);
}

// Rust identifiers cannot start with a digit, so tasks.md's `21st_op_too_large` is spelled out.
#[test]
fn twenty_first_op_too_large() {
    let ops = |n: usize| -> Vec<Value> {
        (0..n)
            .map(|_| json!({"op": "remove", "id": "i1"}))
            .collect()
    };
    assert_eq!(decode_ops(&ops(20)).unwrap().len(), 20);
    assert_eq!(
        decode_ops(&ops(21)),
        Err(ChecklistError::field(ErrorCode::TooLarge, "ops"))
    );
}

#[test]
fn forty_first_item_too_large() {
    let mut list = checklist((1..=40).map(|n| item(&format!("i{n}"))).collect());
    let new = NewItem {
        text: "one more".into(),
        owner: None,
        requires_value: None,
        agent_completable: None,
        group: None,
    };
    assert_eq!(
        add_item(&mut list, None, &new, 2, Actor::Agent),
        Err(ChecklistError::field(ErrorCode::TooLarge, "items"))
    );
    assert_eq!(list.items.len(), 40);
    list.items.pop();
    assert!(add_item(&mut list, None, &new, 2, Actor::Agent).is_ok());
}

#[test]
fn unknown_op_invalid_input() {
    assert_eq!(
        decode_op(&json!({"op": "explode", "id": "i1"})),
        Err(invalid("op"))
    );
    assert_eq!(decode_op(&json!({"id": "i1"})), Err(invalid("op")));
    assert_eq!(
        decode_op(&json!({"op": "remove", "id": "i1", "stray": 1})),
        Err(invalid("op"))
    );
}

#[test]
fn add_op_decodes_optional_owner() {
    let with = decode_op(&json!({"op": "add", "item": {"text": "t", "owner": "human"}})).unwrap();
    let ChecklistOp::Add { item, .. } = with else {
        panic!("not an add");
    };
    assert_eq!(item.owner, Some(ItemOwner::Human));

    let without = decode_op(&json!({"op": "add", "after": "i1", "item": {"text": "t"}})).unwrap();
    let ChecklistOp::Add { after, item } = without else {
        panic!("not an add");
    };
    assert_eq!((item.owner, after.as_deref()), (None, Some("i1")));
}

#[test]
fn add_op_unknown_owner_invalid_input() {
    assert_eq!(
        decode_op(&json!({"op": "add", "item": {"text": "t", "owner": "nobody"}})),
        Err(invalid("op"))
    );
}

#[test]
fn error_code_all_has_thirteen() {
    assert_eq!(ErrorCode::ALL.len(), 13);
    let names: std::collections::HashSet<_> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(names.len(), 13);
    assert_eq!(ErrorCode::NotAgentCompletable.as_str(), "not_agent_completable");
}
