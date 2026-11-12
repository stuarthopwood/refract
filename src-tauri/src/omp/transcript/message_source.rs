// The sender of a user turn that is not Stuart's own: another Session's message (#1858).

use serde::{Deserialize, Serialize};

use crate::agent_tools::envelope;

/// Wire-identical to `model.ts`'s `MessageSource`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MessageSource {
    #[serde(rename_all = "camelCase")]
    Session { session_id: String, name: String },
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
}
