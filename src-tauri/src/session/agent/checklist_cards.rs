// Keeps a checklist turn's source line on the live transcript. Every message frame rebuilds the
// user item from the raw envelope, so a match is remembered and re-applied to the rebuilt item.

use std::collections::HashMap;

use serde_json::Value;

use super::{AgentState, SessionAgent};
use crate::checklist::model::SendRecord;
use crate::checklist::records::text_hash;
use crate::omp::transcript::{MessageSource, TranscriptItem};
use crate::session::checklist_source::apply_checklist_sources;

const OPEN_TAG: &str = "<checklist-item";

/// A match remembered for one item id.
struct Card {
    source: MessageSource,
    body: String,
    /// Hash of the raw envelope that matched, so a rebuilt item with other text is never relabelled.
    raw_hash: String,
}

#[derive(Default)]
pub(super) struct State {
    cards: HashMap<String, Card>,
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
        && message.get("content").is_some_and(opens_with_tag)
}

/// The joined text parts start with the tag; compares in place so a long turn is never copied.
fn opens_with_tag(content: &Value) -> bool {
    let mut want = OPEN_TAG.as_bytes();
    let texts: Vec<&str> = match content {
        Value::String(text) => vec![text.as_str()],
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect(),
        _ => return false,
    };
    for text in texts {
        let take = text.len().min(want.len());
        if text.as_bytes()[..take] != want[..take] {
            return false;
        }
        want = &want[take..];
        if want.is_empty() {
            return true;
        }
    }
    false
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

/// A freshly loaded transcript starts over: no match carries across, then `records` relabel it.
pub(super) fn reload(state: &mut AgentState, records: &[SendRecord]) {
    clear(state);
    label_transcript(state, records);
}

/// What `launch` does with the fetched history: merge it, mark the handoff note, relabel cards.
pub(super) fn merge_relaunch_history(
    state: &mut AgentState,
    messages: &[Value],
    terminated_unexpectedly: bool,
    records: &[SendRecord],
) {
    state
        .transcript
        .merge_from_history(messages, terminated_unexpectedly);
    super::queued_handoff::mark_note(state);
    reload(state, records);
}

/// Relabels remembered turns, then matches any other unlabelled user turn against `records`.
fn label_transcript(state: &mut AgentState, records: &[SendRecord]) {
    let remembered: Vec<TranscriptItem> = state
        .transcript
        .items()
        .iter()
        .filter_map(|item| {
            let TranscriptItem::User {
                id,
                text,
                source: None,
                ..
            } = item.as_ref()
            else {
                return None;
            };
            let card = state.checklist_cards.cards.get(id)?;
            if card.raw_hash != text_hash(text) {
                return None;
            }
            let mut relabelled = item.as_ref().clone();
            if let TranscriptItem::User {
                text, source: slot, ..
            } = &mut relabelled
            {
                *text = card.body.clone();
                *slot = Some(card.source.clone());
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
    let changes = apply_checklist_sources(state.transcript.items(), records);
    for (index, item) in changes {
        let raw_hash = match state.transcript.items().get(index).map(|raw| raw.as_ref()) {
            Some(TranscriptItem::User { text, .. }) => text_hash(text),
            _ => continue,
        };
        if let TranscriptItem::User {
            id,
            text,
            source: Some(source),
            ..
        } = &item
        {
            let card = Card {
                source: source.clone(),
                body: text.clone(),
                raw_hash,
            };
            state.checklist_cards.cards.insert(id.clone(), card);
        }
        state.transcript.upsert_item(item);
    }
}

impl SessionAgent {
    /// The funnel every live frame passes through, with the checklist pre-read the funnel cannot do.
    pub(super) async fn apply_transcript_frame(&self, frame: &Value) {
        // Read before the state lock so the store lock never nests inside it.
        let records = if needs_match(frame) {
            Some(self.checklist_send_records().await)
        } else {
            None
        };
        let mut state = self.state.lock().await;
        hold_records(&mut state, records);
        self.apply_frame_locked(&mut state, frame);
    }

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
