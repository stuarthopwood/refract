// Extension notices (#2114): OMP never persists `notify`, so the launch history merge must keep them.

use std::sync::Arc;

use serde_json::json;

use super::super::diff::merge_history_with_live;
use super::{NoticeLevel, NoticeSource, TranscriptItem, TranscriptState};

fn notice(id: &str, text: &str, source: Option<NoticeSource>) -> Arc<TranscriptItem> {
    Arc::new(TranscriptItem::Notice {
        id: id.to_string(),
        level: NoticeLevel::Info,
        text: text.to_string(),
        source,
    })
}

fn user(id: &str) -> Arc<TranscriptItem> {
    Arc::new(TranscriptItem::User {
        id: id.to_string(),
        text: "hi".to_string(),
        at: 0,
        file_attachments: Vec::new(),
        images: Vec::new(),
        source: None,
    })
}

fn texts(items: &[Arc<TranscriptItem>]) -> Vec<(String, Option<NoticeSource>)> {
    items
        .iter()
        .filter_map(|item| match &**item {
            TranscriptItem::Notice { text, source, .. } => Some((text.clone(), *source)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_live_extension_notice_survives_the_history_merge_in_order_and_a_sourceless_one_does_not() {
    let history = vec![user("h0")];
    let live = vec![
        notice("startup-notice-0", "first", Some(NoticeSource::Extension)),
        notice("startup-notice-1", "refract's own", None),
        notice("startup-notice-2", "second", Some(NoticeSource::Extension)),
    ];

    let merged = merge_history_with_live(&history, &live);

    assert_eq!(merged[0].id(), "h0");
    assert_eq!(
        texts(&merged),
        vec![
            ("first".to_string(), Some(NoticeSource::Extension)),
            ("second".to_string(), Some(NoticeSource::Extension)),
        ]
    );
}

#[test]
fn merging_history_twice_keeps_one_copy_of_each_extension_notice() {
    let mut state = TranscriptState::new();
    state.apply_extension_notice(NoticeLevel::Info, "from an extension".to_string());
    let history = [json!({ "role": "user", "content": "hi", "timestamp": 1 })];

    state.merge_from_history(&history, false);
    state.merge_from_history(&history, false);

    assert_eq!(state.items().len(), 2);
    assert_eq!(state.items()[0].id(), "h0");
    assert_eq!(
        texts(state.items()),
        vec![(
            "from an extension".to_string(),
            Some(NoticeSource::Extension)
        )]
    );
}

#[test]
fn a_raw_notice_frame_cannot_claim_an_extension_source_even_across_the_merge() {
    let mut state = TranscriptState::new();
    state.apply_frame(
        &json!({ "type": "notice", "level": "info", "message": "spoofed", "noticeSource": "extension" }),
        false,
    );

    assert_eq!(texts(state.items()), vec![("spoofed".to_string(), None)]);
    state.merge_from_history(&[], false);
    assert!(state.items().is_empty());
}

#[test]
fn a_repeated_extension_warning_collapses_into_one_row_that_keeps_its_source() {
    let mut state = TranscriptState::new();
    state.apply_extension_notice(NoticeLevel::Warning, "low disk".to_string());
    state.apply_extension_notice(NoticeLevel::Warning, "low disk".to_string());

    assert_eq!(
        texts(state.items()),
        vec![(
            "low disk \u{d7}2".to_string(),
            Some(NoticeSource::Extension)
        )]
    );
}

#[test]
fn a_notice_after_the_merge_never_reuses_the_id_of_a_kept_extension_notice() {
    let mut state = TranscriptState::new();
    state.apply_frame(
        &json!({ "type": "notice", "level": "info", "message": "own" }),
        false,
    );
    state.apply_extension_notice(NoticeLevel::Info, "from an extension".to_string());
    state.merge_from_history(&[], false);
    state.apply_frame(
        &json!({ "type": "notice", "level": "info", "message": "later" }),
        false,
    );

    let ids: Vec<&str> = state.items().iter().map(|item| item.id()).collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn command_output_frames_never_reuse_the_id_of_a_kept_high_index_extension_notice() {
    let mut state = TranscriptState::new();
    for message in ["a", "b", "c"] {
        state.apply_frame(
            &json!({ "type": "notice", "level": "info", "message": message }),
            false,
        );
    }
    state.apply_extension_notice(NoticeLevel::Info, "from an extension".to_string());
    state.merge_from_history(&[], false);
    assert_eq!(state.items().len(), 1);
    for n in 0..4 {
        state.apply_frame(
            &json!({ "type": "command_output", "text": format!("out {n}") }),
            false,
        );
    }

    let mut ids: Vec<&str> = state.items().iter().map(|item| item.id()).collect();
    assert_eq!(ids.len(), 5);
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 5);
}

#[test]
fn error_and_aborted_notices_never_reuse_the_id_of_a_kept_extension_notice_after_the_user_acted() {
    let mut state = TranscriptState::new();
    state.mark_user_acted();
    for message in ["a", "b", "c"] {
        state.apply_frame(
            &json!({ "type": "notice", "level": "info", "message": message }),
            true,
        );
    }
    state.apply_extension_notice(NoticeLevel::Info, "from an extension".to_string());
    state.merge_from_history(&[], true);
    assert_eq!(state.items().len(), 1);
    let kept_id = state.items()[0].id().to_string();
    assert_eq!(kept_id, "notice-3");

    state.apply_frame(&json!({ "type": "command_output", "text": "out" }), true);
    state.apply_frame(
        &json!({ "type": "prompt_result", "status": "error", "error": "boom" }),
        true,
    );
    state.apply_frame(
        &json!({ "type": "prompt_result", "status": "aborted" }),
        true,
    );

    let mut ids: Vec<&str> = state.items().iter().map(|item| item.id()).collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(ids[0], kept_id);
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 4);
}
