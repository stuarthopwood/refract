// The "Do this item" life cycle end to end over the pure engines: the steps the send path and the
// session turn hooks run in order, without a live agent.

use serde_json::json;

use super::developer_ops::apply_developer;
use super::item_message::prepare;
use super::model::{ChecklistFile, ItemStatus, SendAction};
use super::records::{
    clear_resolved, refuse_complete, settle_all, settle_started, settle_unstarted, start_entry,
};
use super::test_support::{checklist, get, item, op};

fn accepted(ids: &[&str]) -> (ChecklistFile, Vec<u64>) {
    let mut file = ChecklistFile::empty();
    file.active = Some(checklist(ids.iter().map(|id| item(id)).collect()));
    let revs = ids
        .iter()
        .map(|id| {
            let base = file.active.as_ref().unwrap().rev;
            prepare(&mut file, "p1", id, base, SendAction::Complete, None)
                .unwrap()
                .rev
        })
        .collect();
    (file, revs)
}

fn status(file: &ChecklistFile, id: &str) -> ItemStatus {
    get(file.active.as_ref().unwrap(), id).status
}

#[test]
fn accept_puts_the_item_in_progress_with_an_unstarted_entry_and_a_record() {
    let (file, revs) = accepted(&["i1"]);

    assert_eq!(status(&file, "i1"), ItemStatus::InProgress);
    assert_eq!(file.pending_complete.len(), 1);
    assert!(!file.pending_complete[0].started);
    assert_eq!(file.pending_complete[0].turn_marker, revs[0]);
    assert_eq!(file.send_records.len(), 1);
}

#[test]
fn a_refused_send_restores_the_item_and_drops_entry_and_record() {
    let (mut file, _) = accepted(&["i1"]);

    assert!(refuse_complete(&mut file, "i1"));

    assert_eq!(status(&file, "i1"), ItemStatus::Upcoming);
    assert!(file.pending_complete.is_empty());
    assert!(file.send_records.is_empty());
}

#[test]
fn a_started_turn_restores_the_item_when_it_settles() {
    let (mut file, revs) = accepted(&["i1"]);

    assert!(start_entry(&mut file, "p1", "i1", revs[0]));
    assert!(settle_started(&mut file));

    assert_eq!(status(&file, "i1"), ItemStatus::Upcoming);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn a_queued_turn_survives_a_settle_and_stop_withdraws_it() {
    let (mut file, revs) = accepted(&["i1", "i2"]);
    start_entry(&mut file, "p1", "i1", revs[0]);

    assert!(settle_started(&mut file));
    assert_eq!(status(&file, "i1"), ItemStatus::Upcoming);
    assert_eq!(status(&file, "i2"), ItemStatus::InProgress);

    assert!(settle_unstarted(&mut file));
    assert_eq!(status(&file, "i2"), ItemStatus::Upcoming);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn a_relaunch_settles_started_and_queued_entries_alike() {
    let (mut file, revs) = accepted(&["i1", "i2"]);
    start_entry(&mut file, "p1", "i1", revs[0]);

    assert!(settle_all(&mut file));

    assert_eq!(status(&file, "i1"), ItemStatus::Upcoming);
    assert_eq!(status(&file, "i2"), ItemStatus::Upcoming);
    assert!(file.pending_complete.is_empty());
}

#[test]
fn a_developer_status_change_blocks_the_restore() {
    let (mut file, revs) = accepted(&["i1"]);
    start_entry(&mut file, "p1", "i1", revs[0]);
    let list = file.active.as_ref().unwrap();
    let ticked = op(json!({"op": "setStatus", "id": "i1", "status": "complete"}));
    file.active = Some(apply_developer(list, list.rev, &ticked).unwrap().checklist);

    assert!(clear_resolved(&mut file));
    assert!(file.pending_complete.is_empty());
    assert!(!settle_started(&mut file));
    assert_eq!(status(&file, "i1"), ItemStatus::Complete);
}

#[test]
fn an_agent_status_change_blocks_the_restore_even_before_it_is_cleared() {
    let (mut file, revs) = accepted(&["i1"]);
    start_entry(&mut file, "p1", "i1", revs[0]);
    let list = file.active.as_mut().unwrap();
    list.rev += 1;
    list.items[0].status = ItemStatus::Complete;
    list.items[0].status_rev = list.rev;

    assert!(settle_started(&mut file));

    assert_eq!(status(&file, "i1"), ItemStatus::Complete);
    assert!(file.pending_complete.is_empty());
}
