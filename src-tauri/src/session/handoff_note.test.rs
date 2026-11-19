// `marked_first_user`: which item gets the handoff label.

use std::sync::Arc;

use super::marked_first_user;
use crate::omp::transcript::{MessageSource, TranscriptItem};

fn user(id: &str, source: Option<MessageSource>) -> Arc<TranscriptItem> {
    Arc::new(TranscriptItem::User {
        id: id.into(),
        text: id.into(),
        at: 1,
        file_attachments: Vec::new(),
        images: Vec::new(),
        source,
    })
}

fn assistant(id: &str) -> Arc<TranscriptItem> {
    Arc::new(TranscriptItem::AssistantText {
        id: id.into(),
        text: "hi".into(),
        streaming: false,
    })
}

fn source_of(item: &TranscriptItem) -> Option<&MessageSource> {
    match item {
        TranscriptItem::User { source, .. } => source.as_ref(),
        _ => None,
    }
}

#[test]
fn a_list_without_a_user_item_gives_none() {
    assert!(marked_first_user(&[assistant("a")]).is_none());
    assert!(marked_first_user(&[]).is_none());
}

#[test]
fn the_first_user_item_is_chosen_even_when_later_ones_exist() {
    let items = [assistant("a"), user("u1", None), user("u2", None)];
    let (index, marked) = marked_first_user(&items).unwrap();
    assert_eq!(index, 1);
    assert_eq!(marked.id(), "u1");
    assert_eq!(source_of(&marked), Some(&MessageSource::Handoff));
}

#[test]
fn a_first_user_item_with_a_source_is_skipped() {
    let from_session = MessageSource::Session {
        session_id: "s".into(),
        name: "A".into(),
    };
    let items = [user("u1", Some(from_session)), user("u2", None)];
    assert!(marked_first_user(&items).is_none());
}

#[test]
fn marking_an_already_marked_list_is_a_no_op() {
    let items = [user("u1", None), user("u2", None)];
    let (index, marked) = marked_first_user(&items).unwrap();
    let mut next = items.to_vec();
    next[index] = Arc::new(marked);
    assert!(marked_first_user(&next).is_none());
}
