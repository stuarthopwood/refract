// Keeps a checklist turn's source line on the live transcript. Every message frame rebuilds the
// user item from the raw envelope, so a match is remembered and re-applied to the rebuilt item.

use std::collections::HashMap;

use serde_json::Value;

use super::{AgentState, SessionAgent};
use crate::checklist::model::SendRecord;
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::checklist_source::apply_checklist_sources;
use crate::session::last_user_message::user_text;

const OPEN_TAG: &str = "<checklist-item";

#[derive(Default)]
pub(super) struct State {
    /// Item id to the source and body already matched for it.
    cards: HashMap<String, (MessageSource, String)>,
    /// Held only while one frame is applied, so the sync transcript funnel can read it.
    records: Option<Vec<SendRecord>>,
}

/// Whether `frame` is a user message that opens with the checklist tag; only then is the store read.
pub(super) fn needs_match(frame: &Value) -> bool {
    let kind = frame.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("message_start" | "message_end")) {
        return false;
    }
    let Some(message) = frame.get("message") else {
        return false;
    };
    message.get("role").and_then(Value::as_str) == Some("user")
        && message
            .get("content")
            .is_some_and(|content| user_text(content).starts_with(OPEN_TAG))
}

/// Forgets every remembered match; the ids belong to the Conversation being left.
pub(super) fn clear(state: &mut AgentState) {
    state.checklist_cards = State::default();
}

/// Hands the funnel the records for the frame about to be applied.
pub(super) fn hold_records(state: &mut AgentState, records: Option<Vec<SendRecord>>) {
    state.checklist_cards.records = records;
}

/// Runs after the handoff label, inside the transcript funnel, so the diff carries the label.
pub(super) fn mark_cards(state: &mut AgentState) {
    let records = state.checklist_cards.records.take().unwrap_or_default();
    if records.is_empty() && state.checklist_cards.cards.is_empty() {
        return;
    }
    label_transcript(state, &records);
}

/// Relabels remembered turns, then matches any other unlabelled user turn against `records`.
pub(super) fn label_transcript(state: &mut AgentState, records: &[SendRecord]) {
    let remembered: Vec<TranscriptItem> = state
        .transcript
        .items()
        .iter()
        .filter_map(|item| {
            let TranscriptItem::User {
                id, source: None, ..
            } = item.as_ref()
            else {
                return None;
            };
            let (source, body) = state.checklist_cards.cards.get(id)?.clone();
            let mut relabelled = item.as_ref().clone();
            if let TranscriptItem::User {
                text, source: slot, ..
            } = &mut relabelled
            {
                *text = body;
                *slot = Some(source);
            }
            Some(relabelled)
        })
        .collect();
    for item in remembered {
        state.transcript.upsert_item(item);
    }
    if records.is_empty() {
        return;
    }
    for (_, item) in apply_checklist_sources(state.transcript.items(), records) {
        if let TranscriptItem::User {
            id,
            text,
            source: Some(source),
            ..
        } = &item
        {
            state
                .checklist_cards
                .cards
                .insert(id.clone(), (source.clone(), text.clone()));
        }
        state.transcript.upsert_item(item);
    }
}

impl SessionAgent {
    /// A snapshot of the Session's send records; empty when the store is unreachable, so the turn
    /// stays plain text.
    pub(crate) async fn checklist_send_records(&self) -> Vec<SendRecord> {
        let Some(manager) = self.tool_manager() else {
            return Vec::new();
        };
        let Some(live) = self.live_checklist_session().await else {
            return Vec::new();
        };
        manager
            .checklists()
            .read(&live, |file| file.send_records.clone())
            .await
            .unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "checklist_cards.test.rs"]
mod tests;
