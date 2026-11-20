use super::*;
use crate::agent_tools::checklist_envelope::parse;
use crate::checklist::model::ChecklistItem;
use crate::checklist::records::has_send_record;
use crate::checklist::test_support::{checklist, developer_item, item};

fn file_with(items: Vec<ChecklistItem>) -> ChecklistFile {
    let mut file = ChecklistFile::empty();
    file.active = Some(checklist(items));
    file
}

fn rev_of(file: &ChecklistFile) -> u64 {
    file.active.as_ref().unwrap().rev
}

fn run(
    file: &mut ChecklistFile,
    action: SendAction,
    text: Option<&str>,
) -> Result<Prepared, ChecklistError> {
    let base = rev_of(file);
    prepare(file, "p1", "i1", base, action, text)
}

/// A refused call leaves the file byte-for-byte as it was.
fn refused(file: &mut ChecklistFile, action: SendAction, text: Option<&str>) -> ChecklistError {
    let before = file.clone();
    let err = run(file, action, text).unwrap_err();
    assert_eq!(*file, before);
    err
}

fn needs_value(mut it: ChecklistItem, by: Actor) -> ChecklistItem {
    it.requires_value = true;
    it.value = Some("v".into());
    it.value_by = Some(by);
    it
}

#[test]
fn ask_changes_nothing_and_records_the_send() {
    let mut file = file_with(vec![item("i1")]);
    let before = file.active.clone();

    let out = run(&mut file, SendAction::Ask, Some("why?")).unwrap();

    assert!(!out.changed);
    assert_eq!(file.active, before);
    assert_eq!(Some(out.checklist), before);
    assert!(file.pending_complete.is_empty());
    assert_eq!(file.send_records.len(), 1);
    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        out.rev,
        SendAction::Ask,
        &out.text
    ));
    assert_eq!(parse(&out.text).unwrap().body, "why?");
}

#[test]
fn value_sets_developer_value_then_records() {
    let mut file = file_with(vec![item("i1")]);

    let out = run(&mut file, SendAction::Value, Some("staging")).unwrap();

    let stored = &file.active.as_ref().unwrap().items[0];
    assert_eq!(stored.value.as_deref(), Some("staging"));
    assert_eq!(stored.value_by, Some(Actor::Developer));
    assert!(out.changed);
    assert_eq!(out.rev, 2);
    assert_eq!(file.active, Some(out.checklist.clone()));
    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        2,
        SendAction::Value,
        &out.text
    ));
    let envelope = parse(&out.text).unwrap();
    assert_eq!((envelope.rev, envelope.body.as_str()), (2, "staging"));
}

#[test]
fn value_over_cap_is_too_large() {
    let mut file = file_with(vec![item("i1")]);

    let err = refused(&mut file, SendAction::Value, Some(&"a".repeat(1025)));

    assert_eq!(err, ChecklistError::field(ErrorCode::TooLarge, "text"));
    assert!(run(&mut file, SendAction::Value, Some(&"a".repeat(1024))).is_ok());
}

#[test]
fn ask_over_cap_is_too_large() {
    let mut file = file_with(vec![item("i1")]);

    let err = refused(&mut file, SendAction::Ask, Some(&"a".repeat(4097)));

    assert_eq!(err, ChecklistError::field(ErrorCode::TooLarge, "text"));
    assert!(run(&mut file, SendAction::Ask, Some(&"a".repeat(4096))).is_ok());
}

#[test]
fn blank_text_is_invalid_input() {
    for action in [SendAction::Ask, SendAction::Value] {
        for text in [None, Some(""), Some(" \n\t ")] {
            let mut file = file_with(vec![item("i1")]);

            let err = refused(&mut file, action, text);

            assert_eq!(err, ChecklistError::field(ErrorCode::InvalidInput, "text"));
        }
    }
}

#[test]
fn complete_checks_order_unknown_then_not_completable_then_value_required() {
    let mut blocked = item("i1");
    blocked.agent_completable = false;
    blocked.requires_value = true;
    let mut file = file_with(vec![blocked]);
    let base = rev_of(&file);

    let unknown = prepare(&mut file, "p1", "i9", base, SendAction::Complete, None).unwrap_err();
    let not_completable = refused(&mut file, SendAction::Complete, None);
    assert_eq!(unknown.code, ErrorCode::UnknownItem);
    assert_eq!(not_completable.code, ErrorCode::NotAgentCompletable);

    let mut needs = item("i1");
    needs.requires_value = true;
    let mut file = file_with(vec![needs]);
    assert_eq!(
        refused(&mut file, SendAction::Complete, None).code,
        ErrorCode::ValueRequired
    );
}

#[test]
fn complete_is_not_agent_completable_for_each_ineligible_item() {
    let mut human = item("i1");
    human.owner = ItemOwner::Human;
    let mut done = item("i1");
    done.status = ItemStatus::Complete;
    for it in [human, done, developer_item("i1")] {
        let mut file = file_with(vec![it]);

        let err = refused(&mut file, SendAction::Complete, None);

        assert_eq!(err.code, ErrorCode::NotAgentCompletable);
        assert_eq!(err.item_ids, vec!["i1".to_string()]);
    }

    let mut file = file_with(vec![item("i1")]);
    run(&mut file, SendAction::Complete, None).unwrap();
    let twice = refused(&mut file, SendAction::Complete, None);
    assert_eq!(twice.code, ErrorCode::NotAgentCompletable);
}

#[test]
fn a_pending_complete_is_refused_before_the_value_check() {
    let mut file = file_with(vec![item("i1")]);
    run(&mut file, SendAction::Complete, None).unwrap();
    let list = file.active.as_mut().unwrap();
    list.items[0].requires_value = true;
    list.items[0].value_by = Some(Actor::Agent);

    let err = refused(&mut file, SendAction::Complete, None);

    assert_eq!(err.code, ErrorCode::NotAgentCompletable);
}

#[test]
fn complete_requires_developer_value_not_agent_value() {
    let mut file = file_with(vec![needs_value(item("i1"), Actor::Agent)]);
    assert_eq!(
        refused(&mut file, SendAction::Complete, None).code,
        ErrorCode::ValueRequired
    );

    let mut file = file_with(vec![needs_value(item("i1"), Actor::Developer)]);
    assert!(run(&mut file, SendAction::Complete, None).is_ok());
}

#[test]
fn stale_base_rev_is_item_changed_on_value_and_complete() {
    let mut touched = item("i1");
    touched.rev = 5;
    for action in [SendAction::Value, SendAction::Complete] {
        let mut file = file_with(vec![touched.clone()]);
        let before = file.clone();

        let err = prepare(&mut file, "p1", "i1", 3, action, Some("x")).unwrap_err();

        assert_eq!(err.code, ErrorCode::ItemChanged);
        assert_eq!(file, before);
        assert!(prepare(&mut file, "p1", "i1", 5, action, Some("x")).is_ok());
    }
}

#[test]
fn complete_template_names_who_wrote_the_step() {
    let agent_wrote = item("i1");
    let mut edited = item("i1");
    edited.edited_by_developer = true;
    let mut dev_step = item("i1");
    dev_step.created_by = Actor::Developer;
    for (it, wording) in [
        (agent_wrote, "this step you wrote."),
        (edited, "this step the developer wrote."),
        (dev_step, "this step the developer wrote."),
    ] {
        let mut file = file_with(vec![it]);

        let out = run(&mut file, SendAction::Complete, None).unwrap();

        let body = parse(&out.text).unwrap().body;
        assert!(body.contains(wording), "{body}");
        assert!(body.ends_with("\n> step i1"));
    }
}

#[test]
fn record_is_written_with_the_state_change() {
    let mut file = file_with(vec![item("i1")]);

    let out = run(&mut file, SendAction::Complete, None).unwrap();

    let stored = &file.active.as_ref().unwrap().items[0];
    assert_eq!(stored.status, ItemStatus::InProgress);
    assert_eq!(stored.status_rev, out.rev);
    assert_eq!(file.pending_complete.len(), 1);
    assert_eq!(file.pending_complete[0].turn_marker, out.rev);
    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        out.rev,
        SendAction::Complete,
        &out.text
    ));
    assert_eq!(parse(&out.text).unwrap().rev, out.rev);
    assert_eq!(file.active, Some(out.checklist));
}

#[test]
fn a_refused_call_writes_no_record() {
    let mut file = file_with(vec![item("i1")]);

    refused(&mut file, SendAction::Ask, Some(" "));
    let wrong_list = prepare(&mut file, "p9", "i1", 1, SendAction::Ask, Some("x")).unwrap_err();

    assert_eq!(
        wrong_list,
        ChecklistError::field(ErrorCode::InvalidInput, "checklistId")
    );
    assert!(file.send_records.is_empty());
}
