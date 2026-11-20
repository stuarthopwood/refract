use serde_json::json;

use super::*;
use crate::checklist::agent_ops::apply_agent;
use crate::checklist::developer_ops::apply_developer;
use crate::checklist::ops::{find, remove_item, ErrorCode};
use crate::checklist::test_support::{checklist, item, op};

fn dev(list: &Checklist, value: serde_json::Value) -> Checklist {
    apply_developer(list, list.rev, &op(value))
        .unwrap()
        .checklist
}

fn two_items() -> Checklist {
    checklist(vec![item("i1"), item("i2"), item("i3")])
}

#[test]
fn user_changes_oldest_first_names_only() {
    let list = two_items();
    let list = dev(
        &list,
        json!({"op": "setValue", "id": "i2", "value": "TOPSECRET"}),
    );
    let list = dev(&list, json!({"op": "edit", "id": "i1", "text": "NEWTEXT"}));
    let list = dev(
        &list,
        json!({"op": "setStatus", "id": "i3", "status": "complete"}),
    );
    let list = dev(&list, json!({"op": "remove", "id": "i2"}));

    let set = user_changes(&list);
    let revs: Vec<_> = set.changes.iter().map(|c| c.rev).collect();
    assert!(revs.windows(2).all(|w| w[0] <= w[1]), "{revs:?}");
    let ops: Vec<_> = set
        .changes
        .iter()
        .map(|c| (c.item_id.as_str(), c.op))
        .collect();
    assert_eq!(
        ops,
        [
            ("i1", OpKind::Edit),
            ("i3", OpKind::SetStatus),
            ("i2", OpKind::Remove),
        ]
    );
    assert_eq!(set.changes[0].fields, ["text"]);
    assert_eq!(set.changes[1].status, Some(ItemStatus::Complete));
    let rendered = format!("{set:?}");
    assert!(!rendered.contains("TOPSECRET") && !rendered.contains("NEWTEXT"));
    assert_eq!((set.more, set.seen_rev), (false, list.rev));
}

#[test]
fn agent_changes_are_not_reported() {
    let list = two_items();
    let applied = apply_agent(
        &list,
        list.rev,
        &[op(json!({"op": "setStatus", "id": "i1", "status": "next"}))],
    )
    .unwrap();
    assert!(user_changes(&applied.checklist).changes.is_empty());
}

#[test]
fn lost_result_returns_same_changes_again() {
    let list = dev(
        &two_items(),
        json!({"op": "setStatus", "id": "i1", "status": "complete"}),
    );
    assert_eq!(user_changes(&list), user_changes(&list));
    assert_eq!(list.agent_seen_rev, 0);
    assert_eq!(user_changes(&list).changes.len(), 1);
}

#[test]
fn seen_rev_raises_to_min_base_issued() {
    let mut list = two_items();
    list.rev = 10;
    list.issued_seen_rev = 6;
    acknowledge(&mut list, Some(4));
    assert_eq!(list.agent_seen_rev, 4);
    // Quoting past what was issued is clamped to the issued mark.
    acknowledge(&mut list, Some(9));
    assert_eq!(list.agent_seen_rev, 6);
    // Never lowered.
    acknowledge(&mut list, Some(2));
    acknowledge(&mut list, None);
    assert_eq!(list.agent_seen_rev, 6);
}

#[test]
fn seen_rev_never_above_rev() {
    let mut list = two_items();
    list.rev = 10;
    list.issued_seen_rev = 50;
    acknowledge(&mut list, Some(40));
    assert_eq!(list.agent_seen_rev, 10);
}

#[test]
fn issued_seen_rev_only_rises() {
    let mut list = two_items();
    issue_seen_rev(&mut list, 7);
    issue_seen_rev(&mut list, 3);
    assert_eq!(list.issued_seen_rev, 7);
}

#[test]
fn twenty_changes_cap_sets_more_changes() {
    let mut list = checklist((1..=25).map(|n| item(&format!("i{n}"))).collect());
    for n in 1..=25 {
        list = dev(
            &list,
            json!({"op": "setStatus", "id": format!("i{n}"), "status": "next"}),
        );
    }
    let set = user_changes(&list);
    assert_eq!(set.changes.len(), 20);
    assert!(set.more);
    let last = set.changes.last().unwrap().rev;
    assert_eq!(set.seen_rev, last);
    assert!(set.seen_rev < list.rev);

    // Quoting the returned seenRev delivers the rest, in order and without a gap.
    list.issued_seen_rev = set.seen_rev;
    acknowledge(&mut list, Some(set.seen_rev));
    let rest = user_changes(&list);
    assert_eq!(rest.changes.len(), 5);
    assert!(!rest.more);
    assert_eq!(rest.seen_rev, list.rev);
}

#[test]
fn quoting_rev_after_overflow_cannot_skip_changes() {
    let mut list = checklist((1..=25).map(|n| item(&format!("i{n}"))).collect());
    for n in 1..=25 {
        list = dev(
            &list,
            json!({"op": "setStatus", "id": format!("i{n}"), "status": "next"}),
        );
    }
    let set = user_changes(&list);
    list.issued_seen_rev = set.seen_rev;
    let rev = list.rev;
    acknowledge(&mut list, Some(rev));
    assert_eq!(list.agent_seen_rev, set.seen_rev);
    assert_eq!(user_changes(&list).changes.len(), 5);
}

#[test]
fn removed_pruned_at_or_below_seen_rev() {
    let list = dev(&two_items(), json!({"op": "remove", "id": "i1"}));
    let mut list = dev(&list, json!({"op": "remove", "id": "i2"}));
    assert_eq!(list.removed.len(), 2);
    list.issued_seen_rev = list.rev;
    let rev = list.removed[0].rev;
    acknowledge(&mut list, Some(rev));
    assert_eq!(list.removed.len(), 1);
    assert_eq!(list.removed[0].id, "i2");
}

#[test]
fn removed_capped_at_40_ids_still_retired() {
    let mut list = checklist((1..=40).map(|n| item(&format!("i{n}"))).collect());
    for n in 1..=40 {
        remove_item(&mut list, &format!("i{n}"), n, Actor::Developer).unwrap();
    }
    let mut list2 = list.clone();
    list2.items.push(item("i41"));
    list2.next_item_seq = 42;
    remove_item(&mut list2, "i41", 41, Actor::Developer).unwrap();
    assert_eq!(list2.removed.len(), 40);
    assert!(list2.removed.iter().all(|r| r.id != "i1"));
    assert_eq!(find(&list2, "i1").unwrap_err().code, ErrorCode::ItemRemoved);
}

#[test]
fn watermark_persisted_with_own_op() {
    let mut list = dev(
        &two_items(),
        json!({"op": "setStatus", "id": "i1", "status": "complete"}),
    );
    let rev = list.rev;
    issue_seen_rev(&mut list, rev);
    let quoted = list.rev;

    let mut applied = apply_agent(
        &list,
        quoted,
        &[op(json!({"op": "setValue", "id": "i2", "value": "v"}))],
    )
    .unwrap()
    .checklist;
    acknowledge(&mut applied, Some(quoted));
    assert_eq!(applied.agent_seen_rev, quoted);
    assert_eq!(get_value(&applied, "i2"), Some("v"));
    assert!(user_changes(&applied).changes.is_empty());

    // A refused call returns no checklist, so its watermark never reaches the file.
    let refused = apply_agent(&list, quoted, &[op(json!({"op": "remove", "id": "i9"}))]);
    assert!(refused.is_err());
    assert_eq!(list.agent_seen_rev, 0);
}

fn get_value<'a>(list: &'a Checklist, id: &str) -> Option<&'a str> {
    list.items
        .iter()
        .find(|i| i.id == id)
        .unwrap()
        .value
        .as_deref()
}
