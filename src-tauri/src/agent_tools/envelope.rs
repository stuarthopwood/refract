// The wrappers that mark a user turn as a message from another Session (#1858, ADR 0008) or as a
// developer's checklist item turn. Both share one escape table, here, so the round trip is tested
// in one place; `checklist_envelope` builds the second wrapper on these helpers.

use crate::session::agent::FirstMessage;

/// Every envelope tag name. A body escapes all of them, so a value quoting one envelope can never
/// close or forge the other.
const TAGS: [&str; 2] = ["session-message", "checklist-item"];
const FROM_ATTR: &str = "<session-message from=\"";
const SESSION_ATTR: &str = "\" session=\"";
const HEADER_END: &str = "\">\n";
const FOOTER: &str = "\n</session-message>";

/// A well-formed envelope, with the escapes already reversed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub session_id: String,
    pub name: String,
    pub body: String,
}

/// Wraps `body` for delivery; `name` and `session_id` come from the stream owner, never the model.
pub fn wrap(name: &str, session_id: &str, body: &str) -> String {
    format!(
        "{FROM_ATTR}{}{SESSION_ATTR}{}{HEADER_END}{}{FOOTER}",
        escape_attr(name),
        escape_attr(session_id),
        escape_body(body)
    )
}

/// The first message of a Conversation a handoff starts. Another Session's prompt travels in its
/// envelope; a self-handoff is the agent's own note, sent raw and recorded as a handoff note.
pub fn first_message(sender: Option<&(String, String)>, prompt: String) -> FirstMessage {
    match sender {
        Some((name, id)) => FirstMessage {
            text: wrap(name, id, &prompt),
            handoff_note: false,
        },
        None => FirstMessage {
            text: prompt,
            handoff_note: true,
        },
    }
}

/// Accepts only text that is exactly one envelope; anything else is a plain user turn.
pub fn parse(text: &str) -> Option<Envelope> {
    let rest = text.strip_prefix(FROM_ATTR)?;
    let (name, rest) = rest.split_once(SESSION_ATTR)?;
    let (session_id, rest) = rest.split_once(HEADER_END)?;
    let body = rest.strip_suffix(FOOTER)?;
    // A raw tag of either name left in the body is a second or forged envelope, which
    // `escape_body` never emits.
    if has_raw_tag(body) {
        return None;
    }
    Some(Envelope {
        session_id: unescape_attr(session_id)?,
        name: unescape_attr(name)?,
        body: unescape_body(body),
    })
}

/// Whether `body` holds a raw envelope tag of any name, open or close.
pub(super) fn has_raw_tag(body: &str) -> bool {
    body.match_indices('<')
        .any(|(at, _)| tag_at(&body[at..]).is_some())
}

pub(super) fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// `None` when a raw `<`, `>` or `"` or an unknown entity is present, as `escape_attr` never emits them.
pub(super) fn unescape_attr(value: &str) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(pos) = rest.find(['&', '<', '>', '"']) {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let (decoded, len) = [
            ("&amp;", '&'),
            ("&quot;", '"'),
            ("&lt;", '<'),
            ("&gt;", '>'),
        ]
        .into_iter()
        .find(|(entity, _)| tail.starts_with(entity))
        .map(|(entity, c)| (c, entity.len()))?;
        out.push(decoded);
        rest = &tail[len..];
    }
    out.push_str(rest);
    Some(out)
}

/// An envelope tag found in a body: `level` -1 is a raw `<tag`, n >= 0 is `&` + n `amp;` + `lt;tag`.
struct TagMatch {
    name: &'static str,
    level: i32,
    closing: bool,
    len: usize,
}

fn tag_at(text: &str) -> Option<TagMatch> {
    let (mut level, mut len) = match text.as_bytes().first()? {
        b'<' => (-1, 1),
        b'&' => (0, 1),
        _ => return None,
    };
    if level == 0 {
        while text[len..].starts_with("amp;") {
            level += 1;
            len += 4;
        }
        len += text[len..].strip_prefix("lt;").map(|_| 3)?;
    }
    let tag = &text[len..];
    let closing = tag.starts_with('/');
    let named = tag.strip_prefix('/').unwrap_or(tag);
    let name = TAGS.into_iter().find(|name| named.starts_with(name))?;
    len += name.len() + usize::from(closing);
    Some(TagMatch {
        name,
        level,
        closing,
        len,
    })
}

/// Moves every envelope tag in `text` one nesting level up (`encode`) or down; a bijection.
fn shift_tags(text: &str, encode: bool) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut copied = 0;
    let mut i = 0;
    while let Some(offset) = text[i..].find(['<', '&']) {
        i += offset;
        let Some(tag) = tag_at(&text[i..]).filter(|t| encode || t.level >= 0) else {
            i += 1;
            continue;
        };
        out.push_str(&text[copied..i]);
        let slash = if tag.closing { "/" } else { "" };
        let level = if encode { tag.level + 1 } else { tag.level - 1 };
        if level < 0 {
            out.push_str(&format!("<{slash}{}", tag.name));
        } else {
            let amps = "amp;".repeat(level as usize);
            out.push_str(&format!("&{amps}lt;{slash}{}", tag.name));
        }
        i += tag.len;
        copied = i;
    }
    out.push_str(&text[copied..]);
    out
}

/// Escapes every envelope tag in a body one nesting level.
pub(super) fn escape_body(body: &str) -> String {
    shift_tags(body, true)
}

/// The inverse of `escape_body`.
pub(super) fn unescape_body(body: &str) -> String {
    shift_tags(body, false)
}

#[cfg(test)]
#[path = "envelope.test.rs"]
mod tests;
