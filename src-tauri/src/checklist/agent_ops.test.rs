use serde_json::{json, Value};

use super::*;
use crate::checklist::model::{ItemOwner, ItemStatus};
use crate::checklist::test_support::{checklist, completed, developer_item, get, item, op};

fn run(list: &Checklist, ops: Vec<Value>) -> Result<Applied, ChecklistError> {
    let ops: Vec<ChecklistOp> = ops.into_iter().map(op).collect();
    apply_agent(list, list.rev, &ops)
}

fn code(result: Result<Applied, ChecklistError>) -> ErrorCode {
    result.unwrap_err().code
}

#[test]
fn edit_complete_item_item_complete() {
    let list = checklist(vec![completed("i1", Actor::Developer)]);
    assert_eq!(
        code(run(
            &list,
            vec![json!({"op": "edit", "id": "i1", "text": "x"})]
        )),
        ErrorCode::ItemComplete
    );
}

#[test]
fn move_remove_setvalue_setstatus_on_complete_item_complete() {
    let list = checklist(vec![item("i1"), completed("i2", Actor::Agent)]);
    for bad in [
        json!({"op": "move", "id": "i2", "after": "i1"}),
        json!({"op": "remove", "id": "i2"}),
        json!({"op": "setValue", "id": "i2", "value": "v"}),
        json!({"op": "setStatus", "id": "i2", "status": "next"}),
    ] {
        assert_eq!(code(run(&list, vec![bad])), ErrorCode::ItemComplete);
    }
}

#[test]
fn agent_cannot_reopen_own_completed_item() {
    let list = checklist(vec![item("i1")]);
    let done = run(
        &list,
        vec![json!({"op": "setStatus", "id": "i1", "status": "complete"})],
    )
    .unwrap()
    .checklist;
    let mut done = done;
    done.issued_seen_rev = done.rev;
    assert_eq!(get(&done, "i1").completed_by, Some(Actor::Agent));
    assert_eq!(
        code(run(
            &done,
            vec![json!({"op": "setStatus", "id": "i1", "status": "in_progress"})]
        )),
        ErrorCode::ItemComplete
    );
}

#[test]
fn edit_developer_item_developer_item() {
    let mut edited = item("i2");
    edited.edited_by_developer = true;
    let list = checklist(vec![developer_item("i1"), edited]);
    for id in ["i1", "i2"] {
        assert_eq!(
            code(run(
                &list,
                vec![json!({"op": "edit", "id": id, "text": "x"})]
            )),
            ErrorCode::DeveloperItem
        );
    }
}

#[test]
fn remove_item_with_developer_value_developer_item() {
    let mut it = item("i1");
    it.value = Some("staging".into());
    it.value_by = Some(Actor::Developer);
    let list = checklist(vec![it]);
    assert_eq!(
        code(run(&list, vec![json!({"op": "remove", "id": "i1"})])),
        ErrorCode::DeveloperItem
    );
}

#[test]
fn setvalue_over_developer_value_developer_item() {
    let mut it = item("i1");
    it.value = Some("staging".into());
    it.value_by = Some(Actor::Developer);
    let list = checklist(vec![it]);
    for value in ["prod", ""] {
        assert_eq!(
            code(run(
                &list,
                vec![json!({"op": "setValue", "id": "i1", "value": value})]
            )),
            ErrorCode::DeveloperItem
        );
    }
}

#[test]
fn owner_requiresvalue_agentcompletable_field_locked() {
    let list = checklist(vec![item("i1")]);
    for (key, value) in [
        ("owner", json!("human")),
        ("requiresValue", json!(true)),
        ("agentCompletable", json!(false)),
    ] {
        let edit = json!({"op": "edit", "id": "i1", key: value});
        let err = run(&list, vec![edit]).unwrap_err();
        assert_eq!((err.code, err.field), (ErrorCode::FieldLocked, Some(key)));
    }
}

#[test]
fn human_owned_complete_fails() {
    let mut it = item("i1");
    it.owner = ItemOwner::Human;
    let list = checklist(vec![it]);
    assert_eq!(
        code(run(
            &list,
            vec![json!({"op": "setStatus", "id": "i1", "status": "complete"})]
        )),
        ErrorCode::HumanOwned
    );
}

#[test]
fn requires_value_without_developer_value_fails() {
    let mut none = item("i1");
    none.requires_value = true;
    let mut by_agent = item("i2");
    by_agent.requires_value = true;
    by_agent.value = Some("mine".into());
    by_agent.value_by = Some(Actor::Agent);
    let list = checklist(vec![none, by_agent]);
    for id in ["i1", "i2"] {
        assert_eq!(
            code(run(
                &list,
                vec![json!({"op": "setStatus", "id": id, "status": "complete"})]
            )),
            ErrorCode::ValueRequired
        );
    }
}

#[test]
fn either_item_completable() {
    let mut it = item("i1");
    it.owner = ItemOwner::Either;
    let list = checklist(vec![it]);
    let done = run(
        &list,
        vec![json!({"op": "setStatus", "id": "i1", "status": "complete"})],
    )
    .unwrap()
    .checklist;
    assert_eq!(get(&done, "i1").status, ItemStatus::Complete);
}

#[test]
fn one_bad_op_applies_nothing() {
    let list = checklist(vec![item("i1"), completed("i2", Actor::Developer)]);
    let before = list.clone();
    let result = run(
        &list,
        vec![
            json!({"op": "edit", "id": "i1", "text": "changed"}),
            json!({"op": "add", "item": {"text": "new"}}),
            json!({"op": "remove", "id": "i2"}),
        ],
    );
    assert_eq!(code(result), ErrorCode::ItemComplete);
    assert_eq!(list, before);
}

#[test]
fn stale_base_rev_conflict_applies_nothing() {
    let mut moved = item("i2");
    moved.rev = 5;
    let mut list = checklist(vec![item("i1"), moved]);
    list.issued_seen_rev = 3;
    let before = list.clone();
    let ops = vec![
        op(json!({"op": "edit", "id": "i1", "text": "x"})),
        op(json!({"op": "setStatus", "id": "i2", "status": "next"})),
    ];
    let err = apply_agent(&list, 3, &ops).unwrap_err();
    assert_eq!(
        (err.code, err.item_ids),
        (ErrorCode::Conflict, vec!["i2".to_string()])
    );
    assert_eq!(list, before);
}

#[test]
fn base_rev_above_issued_seen_rev_still_conflicts_on_unseen_change() {
    let mut unseen = item("i2");
    unseen.rev = 5;
    let mut list = checklist(vec![item("i1"), unseen]);
    list.issued_seen_rev = 3;
    let ops = vec![op(json!({"op": "setStatus", "id": "i2", "status": "next"}))];
    let err = apply_agent(&list, 99, &ops).unwrap_err();
    assert_eq!(
        (err.code, err.item_ids),
        (ErrorCode::Conflict, vec!["i2".to_string()])
    );
}

#[test]
fn agent_add_with_owner_human_sets_human() {
    let list = checklist(vec![item("i1")]);
    let out = run(
        &list,
        vec![json!({"op": "add", "item": {"text": "ask", "owner": "human"}})],
    )
    .unwrap();
    assert_eq!(out.added_ids, vec!["i2".to_string()]);
    let added = get(&out.checklist, "i2");
    assert_eq!(
        (added.owner, added.created_by),
        (ItemOwner::Human, Actor::Agent)
    );
}

#[test]
fn agent_add_without_owner_defaults_agent() {
    let list = checklist(vec![item("i1")]);
    let out = run(&list, vec![json!({"op": "add", "item": {"text": "do it"}})]).unwrap();
    assert_eq!(get(&out.checklist, "i2").owner, ItemOwner::Agent);
}

#[test]
fn agent_cannot_complete_item_it_added_for_human() {
    let list = checklist(vec![item("i1")]);
    let added = run(
        &list,
        vec![json!({"op": "add", "item": {"text": "ask", "owner": "human"}})],
    )
    .unwrap()
    .checklist;
    let mut added = added;
    added.issued_seen_rev = added.rev;
    assert_eq!(
        code(run(
            &added,
            vec![json!({"op": "setStatus", "id": "i2", "status": "complete"})]
        )),
        ErrorCode::HumanOwned
    );
}

const CASES: u64 = 600;
const CALLS_PER_CASE: usize = 6;

/// xorshift64: a seeded generator keeps every failing case reproducible from its index.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }

    fn pick<'a>(&mut self, options: &[&'a str]) -> &'a str {
        options[self.below(options.len())]
    }
}

fn starting_list() -> Checklist {
    let mut valued = developer_item("i4");
    valued.value = Some("staging".into());
    valued.value_by = Some(Actor::Developer);
    let mut gated = item("i5");
    gated.requires_value = true;
    gated.value = Some("ok".into());
    gated.value_by = Some(Actor::Developer);
    let mut own_value = item("i6");
    own_value.value = Some("mine".into());
    own_value.value_by = Some(Actor::Agent);
    let mut either = item("i7");
    either.owner = ItemOwner::Either;
    either.requires_value = true;
    let mut human = item("i8");
    human.owner = ItemOwner::Human;
    checklist(vec![
        item("i1"),
        completed("i2", Actor::Developer),
        completed("i3", Actor::Agent),
        valued,
        gated,
        own_value,
        either,
        human,
    ])
}

fn random_op(rng: &mut Rng) -> Value {
    // i99 never exists, so unknown-item failures are part of the mix.
    let ids = [
        "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i99",
    ];
    let id = rng.pick(&ids);
    match rng.below(7) {
        0 => json!({"op": "add", "after": rng.pick(&ids), "item": {"text": "n"}}),
        1 => json!({"op": "edit", "id": id, "text": "edited"}),
        2 => json!({"op": "move", "id": id, "after": rng.pick(&ids)}),
        3 => json!({"op": "remove", "id": id}),
        4 => json!({"op": "setStatus", "id": id,
            "status": rng.pick(&["upcoming", "next", "in_progress", "blocked", "complete"])}),
        5 => json!({"op": "setValue", "id": id, "value": rng.pick(&["", "x", "y"])}),
        _ => json!({"op": "edit", "id": id, "group": "g"}),
    }
}

fn assert_survives(before: &Checklist, after: &Checklist, case: u64) {
    for old in &before.items {
        let kept = after.items.iter().find(|i| i.id == old.id);
        if old.status == ItemStatus::Complete {
            assert_eq!(kept, Some(old), "case {case}: completed {} changed", old.id);
        }
        if old.value_by == Some(Actor::Developer) {
            let kept = kept.unwrap_or_else(|| panic!("case {case}: {} was removed", old.id));
            assert_eq!(
                (&kept.value, kept.value_by),
                (&old.value, old.value_by),
                "case {case}: developer value on {} changed",
                old.id
            );
        }
    }
}

#[test]
fn property_completed_items_and_developer_values_survive_any_agent_ops() {
    let mut accepted = 0;
    for case in 0..CASES {
        let mut rng = Rng::new(case + 1);
        let mut list = starting_list();
        for _ in 0..CALLS_PER_CASE {
            let ops: Vec<ChecklistOp> = (0..=rng.below(4))
                .map(|_| op(random_op(&mut rng)))
                .collect();
            if let Ok(applied) = apply_agent(&list, list.rev, &ops) {
                assert_survives(&list, &applied.checklist, case);
                list = applied.checklist;
                accepted += 1;
            }
        }
    }
    // A generator whose calls were all rejected would pass the invariants without testing them.
    assert!(accepted > 500, "only {accepted} calls were accepted");
}
