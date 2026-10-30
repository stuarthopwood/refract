// Subagent/parent IRC messages (#838): OMP delivers `customType: "irc:incoming"` with `details`
// `id`, `from`, `message` and sometimes `fromParent`, `replyTo`, `wakeRelay`; never `to`.
// A missing `to` defaults to "main agent", except when `fromParent` is true (recipient is this subagent).

use serde_json::Value;

use super::{as_timestamp, now_ms, TranscriptItem};

const AGENT_MESSAGE_CUSTOM_TYPES: &[&str] = &[
    "irc:incoming",
    "agent-message",
    "agent_message",
    "irc-message",
    "irc_message",
    "subagent-message",
];

pub(super) fn try_build_agent_message(
    message_id: &str,
    custom_type: &str,
    message: &Value,
) -> Option<TranscriptItem> {
    let details = message.get("details");
    let looks_like_agent_message = AGENT_MESSAGE_CUSTOM_TYPES.contains(&custom_type)
        || details
            .map(|d| {
                d.get("from").and_then(Value::as_str).is_some()
                    || d.get("sender").and_then(Value::as_str).is_some()
            })
            .unwrap_or(false);
    if !looks_like_agent_message {
        return None;
    }
    let d = details;
    let str_field = |name: &str| d.and_then(|d| d.get(name).and_then(Value::as_str));
    let from = str_field("from")
        .or_else(|| str_field("sender"))
        .unwrap_or("subagent")
        .to_string();
    let from_parent = d.and_then(|d| d.get("fromParent").and_then(Value::as_bool));
    let default_to = if from_parent == Some(true) {
        "this agent"
    } else {
        "main agent"
    };
    let to = str_field("to")
        .or_else(|| str_field("recipient"))
        .unwrap_or(default_to)
        .to_string();
    let text = str_field("text")
        .or_else(|| str_field("message"))
        .map(String::from)
        .unwrap_or_else(|| {
            message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        });
    // `replyTo` is the id of the message this one answers; a string on the wire, but accept a
    // number defensively rather than drop it.
    let reply_to = d.and_then(|d| d.get("replyTo")).and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    });
    let at = as_timestamp(message, "timestamp").unwrap_or_else(now_ms);
    Some(TranscriptItem::AgentMessage {
        id: format!("agent-message:{message_id}"),
        from,
        to,
        text,
        at,
        from_parent,
        reply_to,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn irc_incoming_from_parent_passes_flags_through() {
        let message = json!({
            "role": "custom",
            "customType": "irc:incoming",
            "timestamp": 1,
            "details": { "id": "m1", "from": "Main", "message": "go", "fromParent": true, "replyTo": "m0" }
        });
        let item = try_build_agent_message("x", "irc:incoming", &message).unwrap();
        let wire = serde_json::to_value(&item).unwrap();
        assert_eq!(wire["kind"], "agent-message");
        assert_eq!(wire["from"], "Main");
        assert_eq!(wire["to"], "this agent");
        assert_eq!(wire["text"], "go");
        assert_eq!(wire["fromParent"], true);
        assert_eq!(wire["replyTo"], "m0");
    }

    #[test]
    fn irc_incoming_from_subagent_omits_absent_flags() {
        let message = json!({
            "role": "custom",
            "customType": "irc:incoming",
            "timestamp": 1,
            "details": { "id": "m2", "from": "R3_Worker", "message": "done" }
        });
        let wire =
            serde_json::to_value(try_build_agent_message("y", "irc:incoming", &message).unwrap())
                .unwrap();
        assert_eq!(wire["to"], "main agent");
        assert!(wire.get("fromParent").is_none());
        assert!(wire.get("replyTo").is_none());
    }
}
