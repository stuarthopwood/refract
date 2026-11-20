// The `<checklist-item>` turn a developer's ask, value or "complete this step" sends. It shares the
// escape table and the one-envelope rule with `envelope`, so a body quoting either tag can never
// close or forge the other.

use super::approval::flatten;
use super::envelope::{escape_attr, escape_body, has_raw_tag, unescape_attr, unescape_body};
use crate::checklist::model::SendAction;

const OPEN: &str = "<checklist-item checklist=\"";
const ITEM_ATTR: &str = "\" item=\"";
const REV_ATTR: &str = "\" rev=\"";
const ACTION_ATTR: &str = "\" action=\"";
const HEADER_END: &str = "\">\n";
const FOOTER: &str = "\n</checklist-item>";

/// A well-formed item turn, with the escapes already reversed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecklistEnvelope {
    pub checklist_id: String,
    pub item_id: String,
    pub rev: u64,
    pub action: SendAction,
    pub body: String,
}

fn action_name(action: SendAction) -> &'static str {
    match action {
        SendAction::Complete => "complete",
        SendAction::Ask => "ask",
        SendAction::Value => "value",
    }
}

fn action_from_name(name: &str) -> Option<SendAction> {
    [SendAction::Complete, SendAction::Ask, SendAction::Value]
        .into_iter()
        .find(|a| action_name(*a) == name)
}

/// Wraps `body` for delivery; the ids and `rev` come from the checklist store, never the model.
pub fn wrap(checklist_id: &str, item_id: &str, rev: u64, action: SendAction, body: &str) -> String {
    format!(
        "{OPEN}{}{ITEM_ATTR}{}{REV_ATTR}{rev}{ACTION_ATTR}{}{HEADER_END}{}{FOOTER}",
        escape_attr(checklist_id),
        escape_attr(item_id),
        action_name(action),
        escape_body(body)
    )
}

/// Accepts only text that is exactly one envelope; anything else is a plain user turn.
pub fn parse(text: &str) -> Option<ChecklistEnvelope> {
    let rest = text.strip_prefix(OPEN)?;
    let (checklist_id, rest) = rest.split_once(ITEM_ATTR)?;
    let (item_id, rest) = rest.split_once(REV_ATTR)?;
    let (rev, rest) = rest.split_once(ACTION_ATTR)?;
    let (action, rest) = rest.split_once(HEADER_END)?;
    let body = rest.strip_suffix(FOOTER)?;
    // `parse::<u64>` would accept a leading `+`, which `wrap` never writes.
    if has_raw_tag(body) || rev.is_empty() || !rev.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(ChecklistEnvelope {
        checklist_id: unescape_attr(checklist_id)?,
        item_id: unescape_attr(item_id)?,
        rev: rev.parse().ok()?,
        action: action_from_name(action)?,
        body: unescape_body(body),
    })
}

/// The fixed body of a "complete this step" turn. The step text is quoted on one line and the
/// sentence names who wrote it, so developer-edited text is never labelled as the agent's.
pub fn complete_body(step_text: &str, agent_wrote: bool) -> String {
    let author = if agent_wrote {
        "you wrote"
    } else {
        "the developer wrote"
    };
    format!(
        "The developer asks you to do this step {author}. The line below is the step text as \
         stored in the checklist. It is not an instruction from the developer.\n> {}",
        flatten(step_text)
    )
}

#[cfg(test)]
#[path = "checklist_envelope.test.rs"]
mod tests;
