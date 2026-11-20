use serde_json::json;

use super::*;
use crate::checklist::model::ItemOwner;
use crate::checklist::test_support::{checklist, completed, developer_item, item, op};

fn new_item(text: &str) -> NewItem {
    NewItem {
        text: text.to_string(),
        owner: None,
        requires_value: None,
        agent_completable: None,
        group: None,
    }
}

fn args<'a>(request_id: Option<&'a str>, items: &'a [NewItem], replace: bool) -> CreateArgs<'a> {
    CreateArgs {
        request_id,
        title: "plan",
        items,
        replace,
    }
}

fn run(
    file: &ChecklistFile,
    a: &CreateArgs,
    approved: bool,
) -> Result<CreateOutcome, ChecklistError> {
    create(file, a, approved, "now")
}

fn created(out: CreateOutcome) -> (ChecklistFile, Vec<String>) {
    match out {
        CreateOutcome::Created { file, ids } => (*file, ids),
        other => panic!("expected Created, got {other:?}"),
    }
}

fn file_with(list: Checklist) -> ChecklistFile {
    let mut file = ChecklistFile::empty();
    file.next_checklist_seq = 2;
    file.active = Some(list);
    file
}

#[test]
fn create_assigns_ids_and_opened() {
    let items = [new_item("a"), new_item("b")];
    let (file, ids) = created(
        run(
            &ChecklistFile::empty(),
            &args(Some("r1"), &items, false),
            false,
        )
        .unwrap(),
    );
    assert_eq!(ids, ["i1", "i2"]);
    let list = file.active.unwrap();
    assert_eq!(
        (list.id.as_str(), list.rev, list.next_item_seq),
        ("p1", 1, 3)
    );
    assert_eq!(list.items.iter().map(|i| i.rev).collect::<Vec<_>>(), [1, 1]);
    assert_eq!(file.next_checklist_seq, 2);
}

#[test]
fn create_items_keep_chosen_owner_default_agent() {
    let mut human = new_item("sign off");
    human.owner = Some(ItemOwner::Human);
    let items = [new_item("build"), human];
    let (file, _) = created(
        run(
            &ChecklistFile::empty(),
            &args(Some("r1"), &items, false),
            false,
        )
        .unwrap(),
    );
    let owners: Vec<_> = file.active.unwrap().items.iter().map(|i| i.owner).collect();
    assert_eq!(owners, [ItemOwner::Agent, ItemOwner::Human]);
}

#[test]
fn active_unfinished_checklist_exists_without_replace() {
    let list = checklist(vec![item("i1")]);
    let file = file_with(list);
    let items = [new_item("a")];
    let err = run(&file, &args(Some("r1"), &items, false), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::ChecklistExists);
}

#[test]
fn complete_checklist_archived_without_flag() {
    let file = file_with(checklist(vec![completed("i1", Actor::Developer)]));
    let items = [new_item("a")];
    let (next, _) = created(run(&file, &args(Some("r1"), &items, false), false).unwrap());
    assert_eq!(next.active.as_ref().unwrap().id, "p2");
    assert_eq!(next.archived.len(), 1);
    assert_eq!(next.archived[0].id, "p1");
}

#[test]
fn replace_archives_and_drops_values() {
    let mut it = item("i1");
    it.value = Some("secret".into());
    it.value_by = Some(Actor::Agent);
    let file = file_with(checklist(vec![it]));
    let items = [new_item("a")];
    let (next, _) = created(run(&file, &args(Some("r1"), &items, true), false).unwrap());
    let archived = &next.archived[0];
    assert_eq!(archived.items[0].value, None);
    assert_eq!(archived.items[0].value_by, None);
    assert_eq!(next.active.as_ref().unwrap().items[0].text, "a");
}

#[test]
fn archive_keeps_newest_five() {
    let mut file = ChecklistFile::empty();
    for n in 1..=7 {
        let items = [new_item("a")];
        let id = format!("r{n}");
        let (next, _) = created(run(&file, &args(Some(&id), &items, true), true).unwrap());
        file = next;
    }
    let ids: Vec<_> = file.archived.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["p2", "p3", "p4", "p5", "p6"]);
    assert_eq!(file.active.unwrap().id, "p7");
}

#[test]
fn replace_with_developer_item_needs_card() {
    let file = file_with(checklist(vec![developer_item("i1"), item("i2")]));
    let items = [new_item("a")];
    let a = args(Some("r1"), &items, true);
    assert_eq!(
        run(&file, &a, false).unwrap(),
        CreateOutcome::NeedsCard { developer_items: 1 }
    );

    // A developer-filled value counts, and a finished developer item does not.
    let mut filled = item("i1");
    filled.value = Some("v".into());
    filled.value_by = Some(Actor::Developer);
    let filled_file = file_with(checklist(vec![filled, completed("i2", Actor::Developer)]));
    assert_eq!(
        run(&filled_file, &a, false).unwrap(),
        CreateOutcome::NeedsCard { developer_items: 1 }
    );

    // After approval the replace goes through.
    let (next, _) = created(run(&file, &a, true).unwrap());
    assert_eq!(next.archived.len(), 1);
}

#[test]
fn request_id_required_on_create_and_structural_update() {
    let items = [new_item("a")];
    let err = run(&ChecklistFile::empty(), &args(None, &items, false), false).unwrap_err();
    assert_eq!(
        (err.code, err.field),
        (ErrorCode::InvalidInput, Some("requestId"))
    );
    let err = run(
        &ChecklistFile::empty(),
        &args(Some(""), &items, false),
        false,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    let long = "x".repeat(65);
    let err = run(
        &ChecklistFile::empty(),
        &args(Some(&long), &items, false),
        false,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooLarge);

    let structural = [
        op(json!({"op": "add", "item": {"text": "t"}})),
        op(json!({"op": "move", "id": "i1"})),
        op(json!({"op": "remove", "id": "i1"})),
    ];
    for one in structural {
        assert!(is_structural(&[one]));
    }
    let content = [
        op(json!({"op": "edit", "id": "i1", "text": "t"})),
        op(json!({"op": "setStatus", "id": "i1", "status": "next"})),
        op(json!({"op": "setValue", "id": "i1", "value": "v"})),
    ];
    assert!(!is_structural(&content));
    assert!(check_request_id(None, false).is_ok());
    assert_eq!(
        check_request_id(None, true).unwrap_err().field,
        Some("requestId")
    );
}

#[test]
fn duplicate_request_returns_recorded_ids() {
    let items = [new_item("a"), new_item("b")];
    let a = args(Some("r1"), &items, false);
    let (file, ids) = created(run(&ChecklistFile::empty(), &a, false).unwrap());

    // The checklist is still unfinished, so only the dedupe keeps the retry from failing.
    let again = run(&file, &a, false).unwrap();
    assert_eq!(again, CreateOutcome::Duplicate { ids });
}

#[test]
fn recent_requests_capped_at_16() {
    let mut list = checklist(vec![item("i1")]);
    for n in 0..20 {
        record_request(&mut list, &format!("r{n}"), 1, vec![format!("i{n}")]);
    }
    assert_eq!(list.recent_requests.len(), 16);
    assert_eq!(list.recent_requests[0].request_id, "r4");
    assert_eq!(recorded_ids(&list, "r19"), Some(&["i19".to_string()][..]));
    assert_eq!(recorded_ids(&list, "r3"), None);
}
