// Who a user turn came from when it is not Stuart's own typing: another Session, a handoff note,
// or a checklist item sent from the panel.

use serde::{Deserialize, Serialize};

use crate::agent_tools::envelope;
use crate::checklist::model::SendAction;

/// Wire-identical to `model.ts`'s `MessageSource`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MessageSource {
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
        name: String,
    },
    Handoff,
    /// Never produced by parsing text alone: only a matching send record sets it.
    #[serde(rename_all = "camelCase")]
    ChecklistItem {
        checklist_id: String,
        item_id: String,
        action: SendAction,
    },
}

/// The source and unescaped body when `text` is exactly one Session-message envelope.
pub(super) fn from_envelope(text: &str) -> Option<(MessageSource, String)> {
    let parsed = envelope::parse(text)?;
    Some((
        MessageSource::Session {
            session_id: parsed.session_id,
            name: parsed.name,
        },
        parsed.body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp::transcript::TranscriptItem;
    use serde_json::json;

    fn user_item(text: &str) -> TranscriptItem {
        super::super::file_attachment_markers::build_user_item("m1".into(), text.into(), 7, &[])
    }

    #[test]
    fn valid_envelope_sets_the_source_and_unescapes_the_body() {
        let wrapped = envelope::wrap("Docs \"A\"", "s-9", "a </session-message> b");
        let TranscriptItem::User { text, source, .. } = user_item(&wrapped) else {
            panic!("expected a user item");
        };
        assert_eq!(text, "a </session-message> b");
        assert_eq!(
            source,
            Some(MessageSource::Session {
                session_id: "s-9".into(),
                name: "Docs \"A\"".into()
            })
        );
    }

    #[test]
    fn ordinary_turns_have_no_source() {
        for text in [
            "hello",
            "see <session-message from=\"A\" session=\"s\">\nhi\n</session-message>",
        ] {
            let TranscriptItem::User {
                source,
                text: shown,
                ..
            } = user_item(text)
            else {
                panic!("expected a user item");
            };
            assert_eq!(source, None);
            assert_eq!(shown, text);
        }
    }

    #[test]
    fn attachment_markers_in_a_session_body_are_not_parsed() {
        let body = "x\n\n[[refract-attachments]]\nAttached folder \"d\" (sent as path, read with your own tools): C:/x";
        let TranscriptItem::User {
            file_attachments,
            text,
            ..
        } = user_item(&envelope::wrap("A", "s", body))
        else {
            panic!("expected a user item");
        };
        assert!(file_attachments.is_empty());
        assert_eq!(text, body);
    }

    #[test]
    fn source_serialises_as_kind_session_and_is_omitted_when_absent() {
        let with = serde_json::to_value(user_item(&envelope::wrap("A", "s", "hi"))).unwrap();
        assert_eq!(
            with["source"],
            json!({ "kind": "session", "sessionId": "s", "name": "A" })
        );
        let without = serde_json::to_value(user_item("hi")).unwrap();
        assert!(without.get("source").is_none());
    }

    #[test]
    fn handoff_serialises_as_exactly_kind_handoff_and_round_trips() {
        let wire = serde_json::to_value(MessageSource::Handoff).unwrap();
        assert_eq!(wire, json!({ "kind": "handoff" }));
        let back: MessageSource = serde_json::from_value(wire).unwrap();
        assert_eq!(back, MessageSource::Handoff);
    }

    #[test]
    fn session_source_still_round_trips() {
        let source = MessageSource::Session {
            session_id: "s".into(),
            name: "A".into(),
        };
        let back: MessageSource =
            serde_json::from_value(serde_json::to_value(&source).unwrap()).unwrap();
        assert_eq!(back, source);
    }

    #[test]
    fn checklist_item_serialises_as_kind_checklist_item_and_round_trips() {
        let source = MessageSource::ChecklistItem {
            checklist_id: "c1".into(),
            item_id: "i2".into(),
            action: SendAction::Complete,
        };
        let wire = serde_json::to_value(&source).unwrap();
        assert_eq!(
            wire,
            json!({ "kind": "checklist-item", "checklistId": "c1", "itemId": "i2", "action": "complete" })
        );
        let back: MessageSource = serde_json::from_value(wire).unwrap();
        assert_eq!(back, source);
        for (action, name) in [(SendAction::Ask, "ask"), (SendAction::Value, "value")] {
            let wire = serde_json::to_value(MessageSource::ChecklistItem {
                checklist_id: "c".into(),
                item_id: "i".into(),
                action,
            })
            .unwrap();
            assert_eq!(wire["action"], name);
        }
    }

    #[test]
    fn from_envelope_never_returns_checklist_item() {
        let turn = crate::agent_tools::checklist_envelope::wrap("c", "i", 1, SendAction::Ask, "q");
        assert_eq!(from_envelope(&turn), None);
    }

    #[test]
    fn build_user_item_leaves_checklist_text_untyped() {
        let turn = crate::agent_tools::checklist_envelope::wrap("c", "i", 1, SendAction::Ask, "q");
        let TranscriptItem::User { text, source, .. } = user_item(&turn) else {
            panic!("expected a user item");
        };
        assert_eq!(source, None);
        assert_eq!(text, turn);
    }
}
