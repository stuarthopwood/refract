// Names, descriptions and parameter schemas of the six Session end tools. The behaviour is in
// `sessions_end_tools`; this is only what the model is shown.

use serde_json::{json, Value};

use super::sessions_end::EndTool;

/// The end tool a registered name belongs to.
pub fn end_tool(name: &str) -> Option<EndTool> {
    EndTool::ALL.into_iter().find(|t| t.name() == name)
}

/// What the model reads for one end tool; each states when the developer is asked.
pub fn description(tool: EndTool) -> &'static str {
    match tool {
        EndTool::Archive => {
            "Archive a Session in your Project, hiding it from the list; links to its parent and \
children are kept. include_children also archives every Session below it. You cannot archive \
yourself, an ancestor or the Personal Agent. The developer is asked first unless Refract runs in \
yolo."
        }
        EndTool::Unarchive => {
            "Bring an archived Session in your Project back. Refused when its parent already has \
4 live children. The developer is asked first unless Refract runs in yolo or the Session is in \
your own tree."
        }
        EndTool::Stop => {
            "Stop a running Session in your Project; its Worktree and Conversations are kept. You \
cannot stop yourself or an ancestor. The developer is asked first unless Refract runs in yolo."
        }
        EndTool::Pause => {
            "Pause a running Session in your Project so it holds new work until resumed. The \
developer is asked first unless Refract runs in yolo or the Session is in your own tree."
        }
        EndTool::Resume => {
            "Resume a paused Session in your Project; a stopped Session is not started. The \
developer is asked first unless Refract runs in yolo or the Session is in your own tree."
        }
        EndTool::Delete => {
            "Delete a Session in your Project, removing its Worktree and Conversations; live child \
Sessions become root Sessions. Removal continues in the background. The developer is always \
asked, even in yolo."
        }
    }
}

/// The `parameters` schema: `id`, plus `include_children` for archive only.
pub fn parameters(tool: EndTool) -> Value {
    let mut properties = json!({
        "id": { "type": "string", "description": "Session id from refract_list_sessions." }
    });
    if tool == EndTool::Archive {
        properties["include_children"] = json!({
            "type": "boolean",
            "description": "Also archive every Session below the target. Default false."
        });
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": ["id"],
        "additionalProperties": false
    })
}

#[cfg(test)]
#[path = "sessions_end_schema.test.rs"]
mod tests;
