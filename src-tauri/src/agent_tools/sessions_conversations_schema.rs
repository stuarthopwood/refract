// Names, descriptions and parameter schemas of the three Conversation tools (#1861). The behaviour
// is in `sessions_conversations`; this is only what the model is shown.

use serde_json::{json, Value};

use super::sessions_conversations::ConvTool;

/// The Conversation tool a registered name belongs to.
pub fn conv_tool(name: &str) -> Option<ConvTool> {
    ConvTool::ALL.into_iter().find(|t| t.name() == name)
}

/// What the model reads for one tool; each states who the target may be and when the developer is asked.
pub fn description(tool: ConvTool) -> &'static str {
    match tool {
        ConvTool::List => {
            "List a Session's Conversations in your Project, newest first, with id, title, \
creation time, whether it is the current one and a preview of its first message. Defaults to your \
own Session; limit is 1 to 100 and defaults to 20. This only reads, so the developer is not asked."
        }
        ConvTool::New => {
            "Start a fresh Conversation in your own Session or in another Session of your Project, \
and send prompt as its first message. When the target is mid-turn the call returns scheduled and \
the new Conversation starts once that turn ends; a stopped Session is launched on it. In your own \
Session the prompt arrives unchanged as a handoff note, so write it to stand alone; another \
Session receives it labelled as from your Session. You cannot target an ancestor, a paused or \
archived Session or the Personal Agent. The developer is asked first unless the target is you or \
below you, or Refract runs in yolo."
        }
        ConvTool::Switch => {
            "Make one of a Session's existing Conversations the current one, using an id from \
refract_list_conversations. Returns unchanged when it is already current. When the target is \
mid-turn the call returns scheduled and the switch happens once that turn ends; a stopped Session \
is launched on it. You cannot target an ancestor, a paused or archived Session or the Personal \
Agent. The developer is asked first unless the target is you or below you, or Refract runs in yolo."
        }
    }
}

/// The `parameters` schema of one tool.
pub fn parameters(tool: ConvTool) -> Value {
    match tool {
        ConvTool::List => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "string", "description": "Session id from refract_list_sessions; omit for your own Session." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many Conversations to return, 1 to 100. Default 20." }
            },
            "additionalProperties": false
        }),
        ConvTool::New => json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "The first message of the new Conversation, up to 32 KB." },
                "session_id": { "type": "string", "description": "Session id from refract_list_sessions; omit for your own Session." }
            },
            "required": ["prompt"],
            "additionalProperties": false
        }),
        ConvTool::Switch => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "string", "description": "Session id from refract_list_sessions." },
                "conversation_id": { "type": "string", "description": "Conversation id from refract_list_conversations." }
            },
            "required": ["session_id", "conversation_id"],
            "additionalProperties": false
        }),
    }
}

#[cfg(test)]
#[path = "sessions_conversations_schema.test.rs"]
mod tests;
