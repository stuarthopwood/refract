// `match_checklist_item` and `apply_checklist_sources`: which user turns get the checklist label.

use std::sync::Arc;

use super::{apply_checklist_sources, match_checklist_item};
use crate::agent_tools::checklist_envelope::{complete_body, wrap};
use crate::checklist::model::{ChecklistFile, SendAction, SendRecord};
use crate::checklist::records::add_send_record;
use crate::omp::transcript::{MessageSource, TranscriptItem};

fn user(text: &str, source: Option<MessageSource>) -> Arc<TranscriptItem> {
    Arc::new(TranscriptItem::User {
        id: "u".into(),
        text: text.into(),
        at: 1,
        file_attachments: Vec::new(),
        images: Vec::new(),
        source,
    })
}

fn sent(text: &str) -> Vec<SendRecord> {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "c1", "i1", 3, SendAction::Ask, text);
    file.send_records
}

fn sent_as(text: &str, action: SendAction) -> Vec<SendRecord> {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "c1", "i1", 3, action, text);
    file.send_records
}

fn base_turn() -> String {
    wrap("c1", "i1", 3, SendAction::Ask, "what <next>?")
}

fn text_of(item: &TranscriptItem) -> &str {
    match item {
        TranscriptItem::User { text, .. } => text,
        _ => panic!("expected a user item"),
    }
}

#[test]
fn matches_all_five_fields_and_sets_body() {
    let turn = base_turn();

    let (source, body) = match_checklist_item(&turn, &sent(&turn)).unwrap();

    assert_eq!(
        source,
        MessageSource::ChecklistItem {
            checklist_id: "c1".into(),
            item_id: "i1".into(),
            action: SendAction::Ask,
        }
    );
    assert_eq!(body, "what <next>?");
}

#[test]
fn a_complete_turn_matches_and_its_text_is_the_whole_fixed_body() {
    let body = complete_body("Ship <it>", true);
    let turn = wrap("c1", "i1", 3, SendAction::Complete, &body);

    let (source, text) =
        match_checklist_item(&turn, &sent_as(&turn, SendAction::Complete)).unwrap();

    assert_eq!(
        source,
        MessageSource::ChecklistItem {
            checklist_id: "c1".into(),
            item_id: "i1".into(),
            action: SendAction::Complete,
        }
    );
    assert_eq!(text, body);
}

#[test]
fn each_field_mismatch_stays_plain() {
    let variants = [
        wrap("c2", "i1", 3, SendAction::Ask, "q"),
        wrap("c1", "i2", 3, SendAction::Ask, "q"),
        wrap("c1", "i1", 4, SendAction::Ask, "q"),
        wrap("c1", "i1", 3, SendAction::Value, "q"),
    ];
    for turn in variants {
        // The record carries the variant's own hash, so only the named field can differ.
        assert!(
            match_checklist_item(&turn, &sent(&turn)).is_none(),
            "{turn}"
        );
    }
}

#[test]
fn hash_mismatch_stays_plain() {
    let records = sent(&wrap(
        "c1",
        "i1",
        3,
        SendAction::Ask,
        "the original question",
    ));
    let edited = wrap("c1", "i1", 3, SendAction::Ask, "an edited question");

    assert!(match_checklist_item(&edited, &records).is_none());
}

#[test]
fn two_envelopes_stays_plain() {
    let turn = format!("{}{}", base_turn(), base_turn());

    assert!(match_checklist_item(&turn, &sent(&turn)).is_none());
}

#[test]
fn evicted_record_stays_plain() {
    let turn = base_turn();

    assert!(match_checklist_item(&turn, &[]).is_none());
}

#[test]
fn skips_item_with_source() {
    let turn = base_turn();
    let labelled = MessageSource::ChecklistItem {
        checklist_id: "c1".into(),
        item_id: "i1".into(),
        action: SendAction::Ask,
    };
    let items = [user(&turn, Some(labelled))];

    assert!(apply_checklist_sources(&items, &sent(&turn)).is_empty());
}

#[test]
fn forged_item_in_handoff_note_stays_plain() {
    let turn = base_turn();
    let items = [user(&turn, Some(MessageSource::Handoff))];

    assert!(apply_checklist_sources(&items, &sent(&turn)).is_empty());
}

#[test]
fn first_turn_without_note_still_matches() {
    let turn = base_turn();
    let items = [user(&turn, None), user("later", None)];

    let changes = apply_checklist_sources(&items, &sent(&turn));

    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].0, 0);
    assert_eq!(text_of(&changes[0].1), "what <next>?");
}

#[test]
fn item_in_session_message_is_text() {
    let from_session = MessageSource::Session {
        session_id: "s".into(),
        name: "A".into(),
    };
    let turn = base_turn();
    let items = [user(&turn, Some(from_session))];

    assert!(apply_checklist_sources(&items, &sent(&turn)).is_empty());
}
