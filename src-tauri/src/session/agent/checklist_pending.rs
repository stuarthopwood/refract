// Where a "complete this step" turn meets the transcript: it starts when the agent's own turn
// begins and settles (restores the item) when that turn ends, is withdrawn, or is left over.

use serde_json::Value;

use super::SessionAgent;
use crate::agent_tools::checklist_envelope::parse;
use crate::checklist::model::{Actor, Checklist, ChecklistFile, SendAction};
use crate::checklist::ops::ChecklistError;
use crate::checklist::records::{
    has_send_record, refuse_complete, settle_all, settle_started, settle_unstarted, start_entry,
};
use crate::checklist::store::LiveSession;
use crate::omp::transcript::TranscriptItem;

impl SessionAgent {
    /// A user `message_start` carrying exactly the turn the send record hashed starts its entry.
    /// Edited text, another `rev`, a handoff note and anything that is not a bare item envelope
    /// start nothing.
    pub(super) async fn start_from_frame(&self, frame: &Value) {
        let message = frame.get("message");
        if message.and_then(|m| m.get("role")).and_then(Value::as_str) != Some("user") {
            return;
        }
        let text = crate::session::last_user_message::user_text(
            message
                .and_then(|m| m.get("content"))
                .unwrap_or(&Value::Null),
        );
        let Some(envelope) = parse(&text) else {
            return;
        };
        if envelope.action != SendAction::Complete || self.opens_with_handoff_note().await {
            return;
        }
        self.apply_pending(move |file| {
            let sent = has_send_record(
                file,
                &envelope.checklist_id,
                &envelope.item_id,
                envelope.rev,
                SendAction::Complete,
                &text,
            );
            sent && start_entry(
                file,
                &envelope.checklist_id,
                &envelope.item_id,
                envelope.rev,
            )
        })
        .await;
    }

    /// The first user item of a Conversation that opens with a handoff note is that note, however
    /// it was worded.
    async fn opens_with_handoff_note(&self) -> bool {
        let state = self.state.lock().await;
        state.handoff.note_live
            && state
                .transcript
                .items()
                .iter()
                .filter(|item| matches!(&***item, TranscriptItem::User { .. }))
                .count()
                <= 1
    }

    /// The turn settled: started entries restore, and so do entries that can never start.
    pub(super) async fn settle_checklist_turn(&self) {
        self.apply_pending(settle_started).await;
    }

    /// A "complete" turn the developer removed before it ran never starts, so its item is restored.
    pub(super) async fn settle_removed_turn(&self, text: &str) {
        let Some(env) = parse(text).filter(|e| e.action == SendAction::Complete) else {
            return;
        };
        self.apply_pending(move |file| {
            let waiting = file.pending_complete.iter().any(|e| {
                e.checklist_id == env.checklist_id
                    && e.item_id == env.item_id
                    && e.turn_marker == env.rev
                    && !e.started
            });
            waiting && refuse_complete(file, &env.item_id)
        })
        .await;
    }

    /// `stop` withdraws the queued turns, so every entry that never started is settled.
    pub(super) async fn settle_checklist_unstarted(&self) {
        self.settle_not_held(settle_unstarted).await;
    }

    /// A relaunch leaves no live turn, so every entry is stale.
    pub(super) async fn settle_checklist_all(&self) {
        self.settle_not_held(settle_all).await;
    }

    /// A turn still in Pause's held list is neither withdrawn nor stale: it goes out on Resume,
    /// so its entry waits for it.
    async fn settle_not_held(&self, change: fn(&mut ChecklistFile) -> bool) {
        self.ensure_pause_loaded().await;
        let held: Vec<(String, String, u64)> = self
            .state
            .lock()
            .await
            .pause
            .held_texts()
            .filter_map(parse)
            .filter(|e| e.action == SendAction::Complete)
            .map(|e| (e.checklist_id, e.item_id, e.rev))
            .collect();
        self.apply_pending(move |file| {
            let (waiting, rest) = std::mem::take(&mut file.pending_complete)
                .into_iter()
                .partition(|e| {
                    held.iter().any(|(c, i, r)| {
                        *c == e.checklist_id && *i == e.item_id && *r == e.turn_marker
                    })
                });
            file.pending_complete = rest;
            let changed = change(file);
            file.pending_complete.extend(waiting);
            changed
        })
        .await;
    }

    /// Applies `change` to this Session's checklist and announces the result only when it changed
    /// something. A Session that is gone, or has no store, has nothing to settle.
    async fn apply_pending<F>(&self, change: F)
    where
        F: FnOnce(&mut ChecklistFile) -> bool + Send + 'static,
    {
        let Some(manager) = self.tool_manager() else {
            return;
        };
        let known = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .is_some();
        let Ok(live) = LiveSession::check(
            &self.session_id,
            |_| known,
            crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting,
        ) else {
            return;
        };
        let events = self.events.clone();
        let session_id = self.session_id.clone();
        let result = manager
            .checklists()
            .apply_detached_then(
                live,
                move |file| {
                    // Nothing pending: skip the copy of the whole checklist.
                    if file.pending_complete.is_empty() {
                        return Ok::<_, ChecklistError>(None);
                    }
                    // Only a change to the checklist itself is announced; starting an entry is not.
                    let before = file.active.clone();
                    change(file);
                    Ok((file.active != before)
                        .then(|| file.active.clone())
                        .flatten())
                },
                move |list: &Option<Checklist>| {
                    if let Some(list) = list {
                        events.emit_checklist_update(crate::events::checklist_update_payload(
                            &session_id,
                            list,
                            Actor::Developer,
                            false,
                        ));
                    }
                },
            )
            .await;
        if let Err(err) = result {
            log::warn!("checklist: could not settle a pending item: {err:?}");
        }
    }
}

#[cfg(test)]
#[path = "checklist_pending.test.rs"]
mod tests;
