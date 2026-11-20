use serde_json::{json, Value};

use super::*;
use crate::checklist::model::{ItemOwner, ItemStatus, OpKind};
use crate::checklist::test_support::{checklist, completed, get, item, op};

fn run(list: &Checklist, base_rev: u64, value: Value) -> Result<Applied, ChecklistError> {
    apply_developer(list, base_rev, &op(value))
}

fn tick(id: &str) -> Value {
    json!({"op": "setStatus", "id": id, "status": "complete"})
}

#[test]
fn tick_sets_complete_by_developer() {
    let mut it = item("i1");
    it.status = ItemStatus::InProgress;
    let list = checklist(vec![it]);
    let out = run(&list, list.rev, tick("i1")).unwrap().checklist;
    let done = get(&out, "i1");
    assert_eq!(done.status, ItemStatus::Complete);
    assert_eq!(done.previous_status, Some(ItemStatus::InProgress));
    assert_eq!(
        (done.completed_by, done.updated_by, done.rev),
        (Some(Actor::Developer), Actor::Developer, out.rev)
    );
    assert_eq!(out.rev, list.rev + 1);
}

#[test]
fn tick_requires_value_without_value_fails() {
    let mut it = item("i1");
    it.requires_value = true;
    let list = checklist(vec![it]);
    let err = run(&list, list.rev, tick("i1")).unwrap_err();
    assert_eq!(err.code, ErrorCode::ValueRequired);

    // The developer's gate accepts any value, an agent-set one included.
    let mut valued = list.clone();
    valued.items[0].value = Some("from the agent".into());
    valued.items[0].value_by = Some(Actor::Agent);
    assert!(run(&valued, valued.rev, tick("i1")).is_ok());
}

#[test]
fn untick_restores_previous() {
    let mut it = completed("i1", Actor::Developer);
    it.previous_status = Some(ItemStatus::Blocked);
    let list = checklist(vec![it]);
    let out = run(
        &list,
        list.rev,
        json!({"op": "setStatus", "id": "i1", "status": "upcoming"}),
    )
    .unwrap()
    .checklist;
    let reopened = get(&out, "i1");
    assert_eq!(reopened.status, ItemStatus::Blocked);
    assert_eq!(reopened.previous_status, None);
}

#[test]
fn edit_sets_edited_by_developer() {
    let list = checklist(vec![item("i1")]);
    let out = run(
        &list,
        list.rev,
        json!({"op": "edit", "id": "i1", "text": "mine"}),
    )
    .unwrap()
    .checklist;
    let edited = get(&out, "i1");
    assert!(edited.edited_by_developer);
    assert_eq!(edited.text, "mine");
    assert_eq!(
        edited.last_developer_ops[0].fields,
        vec!["text".to_string()]
    );
}

#[test]
fn developer_owner_edit_field_locked() {
    let list = checklist(vec![item("i1")]);
    for key in ["owner", "requiresValue", "agentCompletable"] {
        let value = match key {
            "owner" => json!("human"),
            _ => json!(true),
        };
        let err = run(
            &list,
            list.rev,
            json!({"op": "edit", "id": "i1", key: value}),
        )
        .unwrap_err();
        assert_eq!((err.code, err.field), (ErrorCode::FieldLocked, Some(key)));
    }
}

#[test]
fn agent_changed_above_base_rev_item_changed() {
    let mut it = item("i1");
    it.rev = 7;
    it.updated_by = Actor::Agent;
    let list = checklist(vec![it]);
    let err = run(&list, 6, tick("i1")).unwrap_err();
    assert_eq!(
        (err.code, err.item_ids),
        (ErrorCode::ItemChanged, vec!["i1".to_string()])
    );
    assert!(run(&list, 7, tick("i1")).is_ok());
}

#[test]
fn developer_never_conflicts_with_developer() {
    let mut it = item("i1");
    it.rev = 7;
    it.updated_by = Actor::Developer;
    let list = checklist(vec![it]);
    assert!(run(&list, 1, tick("i1")).is_ok());
}

#[test]
fn last_developer_ops_one_record_per_kind() {
    let list = checklist(vec![item("i1"), item("i2")]);
    let ops = [
        tick("i1"),
        json!({"op": "edit", "id": "i1", "text": "a"}),
        json!({"op": "move", "id": "i1", "after": "i2"}),
        json!({"op": "edit", "id": "i1", "text": "b"}),
        json!({"op": "setValue", "id": "i1", "value": "v"}),
    ];
    let mut now = list;
    for next in ops {
        now = run(&now, now.rev, next).unwrap().checklist;
    }
    let records = &get(&now, "i1").last_developer_ops;
    let kinds: Vec<OpKind> = records.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        vec![
            OpKind::SetStatus,
            OpKind::Move,
            OpKind::Edit,
            OpKind::SetValue
        ]
    );
    // The second edit replaced the first, and the move was not hidden by it.
    let edit = records.iter().find(|r| r.kind == OpKind::Edit).unwrap();
    assert_eq!(edit.rev, 5);
}

#[test]
fn remove_records_removed_entry() {
    let list = checklist(vec![item("i1"), item("i2")]);
    let out = run(&list, list.rev, json!({"op": "remove", "id": "i1"}))
        .unwrap()
        .checklist;
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.removed.len(), 1);
    let entry = &out.removed[0];
    assert_eq!(
        (entry.id.as_str(), entry.rev, entry.by),
        ("i1", out.rev, Actor::Developer)
    );
}

#[test]
fn developer_add_defaults_owner_human() {
    let list = checklist(vec![item("i1")]);
    let out = run(
        &list,
        list.rev,
        json!({"op": "add", "item": {"text": "mine"}}),
    )
    .unwrap();
    assert_eq!(out.added_ids, vec!["i2".to_string()]);
    let added = get(&out.checklist, "i2");
    assert_eq!(
        (added.owner, added.created_by),
        (ItemOwner::Human, Actor::Developer)
    );
}

#[test]
fn developer_add_with_owner_either_keeps_either() {
    let list = checklist(vec![item("i1")]);
    let out = run(
        &list,
        list.rev,
        json!({"op": "add", "item": {"text": "shared", "owner": "either"}}),
    )
    .unwrap();
    assert_eq!(get(&out.checklist, "i2").owner, ItemOwner::Either);
}
