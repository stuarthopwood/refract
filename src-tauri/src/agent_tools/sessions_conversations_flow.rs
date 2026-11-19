// `new_conversation` and `switch_conversation` (#1861). Both walk the same gate in the same order,
// and a child of `sessions_conversations` so it reaches that module's private helpers.

use serde_json::{json, Value};

use super::{
    confirm, dispatch, open_gate, parse_new, parse_switch, recheck, sender_for, ConvHost, ConvTool,
    Dispatch, ToolError, NOT_FOUND,
};
use crate::session::agent::HandoffAction;

/// What the caller is told: `done` is the word for an action that ran now.
fn outcome_word(dispatch: Dispatch, done: &'static str) -> &'static str {
    match dispatch {
        Dispatch::Scheduled => "scheduled",
        Dispatch::Done => done,
    }
}

pub(super) async fn new_conversation<H: ConvHost>(
    host: &H,
    args: &Value,
) -> Result<Value, ToolError> {
    let (session_id, prompt) = parse_new(args)?;
    let gate = open_gate(host, session_id.as_deref(), true).await?;
    let asked = confirm(host, ConvTool::New, &gate, &prompt).await?;
    let (gate, _tree) = recheck(host, &gate, asked).await?;
    let sender = sender_for(&gate, host.caller_id());
    let id = gate.target.id;
    let dispatched = dispatch(host, &id, HandoffAction::New { prompt }, sender, asked).await?;
    Ok(json!({ "outcome": outcome_word(dispatched, "started"), "id": id }))
}

pub(super) async fn switch_conversation<H: ConvHost>(
    host: &H,
    args: &Value,
) -> Result<Value, ToolError> {
    let (session_id, conversation_id) = parse_switch(args)?;
    let gate = open_gate(host, Some(&session_id), true).await?;
    let chosen = host
        .conversations(&gate.target.id, None)
        .await
        .into_iter()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| {
            ToolError::new(
                NOT_FOUND,
                format!("Session {session_id} has no Conversation {conversation_id}"),
            )
        })?;
    // Nothing changes, so no card: the list tool shows the same fact without one.
    if chosen.is_current {
        return Ok(
            json!({ "outcome": "unchanged", "id": gate.target.id, "conversation_id": conversation_id }),
        );
    }
    let asked = confirm(host, ConvTool::Switch, &gate, &chosen.title).await?;
    let (gate, _tree) = recheck(host, &gate, asked).await?;
    let sender = sender_for(&gate, host.caller_id());
    let id = gate.target.id;
    let action = HandoffAction::Switch { file: chosen.file };
    let dispatched = dispatch(host, &id, action, sender, asked).await?;
    Ok(json!({
        "outcome": outcome_word(dispatched, "switched"),
        "id": id,
        "conversation_id": conversation_id,
    }))
}
