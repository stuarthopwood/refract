use serde_json::json;

use super::*;
use crate::checklist::developer_ops::apply_developer;
use crate::checklist::model::Actor;
use crate::checklist::model::Checklist;
use crate::checklist::test_support::{checklist, completed, item, op};

fn developer(list: &Checklist, value: serde_json::Value) -> Checklist {
    apply_developer(list, list.rev, &op(value))
        .unwrap()
        .checklist
}

fn file_of(list: Checklist) -> ChecklistFile {
    let mut file = ChecklistFile::empty();
    file.active = Some(list);
    file
}

#[test]
fn hint_has_ids_and_ops_only_never_text_or_values() {
    let mut first = item("i1");
    first.text = "SECRET-TEXT".into();
    let mut list = checklist(vec![first, item("i2"), item("i3")]);
    list.title = "SECRET-TITLE".into();
    list.agent_seen_rev = list.rev;
    let list = developer(
        &list,
        json!({"op": "setStatus", "id": "i2", "status": "complete"}),
    );
    let list = developer(
        &list,
        json!({"op": "setValue", "id": "i3", "value": "SECRET-VALUE"}),
    );
    let list = developer(
        &list,
        json!({"op": "edit", "id": "i1", "text": "SECRET-EDIT"}),
    );

    let hint = checklist_hint(&file_of(list)).unwrap();

    assert_eq!(
        hint,
        "Checklist p1 changed by the developer after rev 1: tick i2, value i3, edit i1. \
         Call refract_checklist get."
    );
    assert!(!hint.contains("SECRET"));
}

#[test]
fn hint_empty_when_agent_seen() {
    let list = checklist(vec![item("i1")]);
    let mut list = developer(
        &list,
        json!({"op": "setStatus", "id": "i1", "status": "complete"}),
    );
    assert!(checklist_hint(&file_of(list.clone())).is_some());

    list.agent_seen_rev = list.rev;

    assert_eq!(checklist_hint(&file_of(list)), None);
    assert_eq!(checklist_hint(&ChecklistFile::empty()), None);
}

#[test]
fn conversation_line_counts_and_ids_only() {
    let mut list = checklist(vec![
        completed("i1", Actor::Agent),
        item("i2"),
        completed("i3", Actor::Developer),
    ]);
    list.title = "SECRET-TITLE".into();
    list.items[1].text = "SECRET-TEXT".into();
    list.rev = 9;

    let line = conversation_line(&file_of(list)).unwrap();

    assert_eq!(
        line,
        "Checklist p1 is active: rev 9, 2 of 3 items complete. Call refract_checklist get."
    );
    assert_eq!(conversation_line(&ChecklistFile::empty()), None);
}
