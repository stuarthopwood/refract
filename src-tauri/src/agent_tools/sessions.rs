// Read tools over the Session registry and live agents (#1858). Rust answers them itself, with no
// renderer round trip and no approval card.

use serde_json::{json, Map, Value};

use super::panels;
use super::router::{ToolError, INVALID_INPUT};
use super::MAX_RESULT_BYTES;
use crate::session::agent::SessionAgent;

pub const LIST_SESSIONS: &str = "refract_list_sessions";
pub const GET_SESSION_STATUS: &str = "refract_get_session_status";
pub const SEND_SESSION_MESSAGE: &str = "refract_send_session_message";
pub const SESSION_TOOLS: [&str; 3] = [LIST_SESSIONS, GET_SESSION_STATUS, SEND_SESSION_MESSAGE];

pub const UNKNOWN_PROJECT: &str = "unknown_project";
pub const NOT_FOUND: &str = "not_found";

const STOP_REASONS: [&str; 5] = [
    "not-started",
    "agent-exited",
    "start-failed",
    "worktree-missing",
    "stopped-on-request",
];

pub fn is_session_tool(name: &str) -> bool {
    SESSION_TOOLS.contains(&name)
}

pub fn description(name: &str) -> &'static str {
    match name {
        LIST_SESSIONS => {
            "List the Sessions in Refract with project, branch, status and last activity. \
Archived Sessions are left out unless include_archived is true. Your own row has self: true."
        }
        GET_SESSION_STATUS => {
            "Read one Session's status (working, waiting-for-approval, idle, paused or stopped), \
why it stopped, its branch and its pull request."
        }
        SEND_SESSION_MESSAGE => {
            "Send a message to another running Session. It arrives as a turn labelled with your \
Session's name. It is sent at once, queued behind the turn in progress, or held while the target \
is paused. A stopped Session is not started."
        }
        _ => "",
    }
}

pub fn parameters(name: &str) -> Value {
    match name {
        LIST_SESSIONS => json!({
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "Project id or name; omit for all projects." },
                "include_archived": { "type": "boolean", "description": "Include archived Sessions." }
            },
            "additionalProperties": false
        }),
        GET_SESSION_STATUS => json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "Session id from refract_list_sessions." } },
            "required": ["id"],
            "additionalProperties": false
        }),
        SEND_SESSION_MESSAGE => json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Target Session id." },
                "text": { "type": "string", "description": "The message, up to 32 KB." }
            },
            "required": ["id", "text"],
            "additionalProperties": false
        }),
        _ => json!({ "type": "object" }),
    }
}

/// Validates `args` against the tool's schema, which also refuses unknown keys.
pub fn check_args(tool: &str, args: &Value) -> Result<(), ToolError> {
    panels::validate(&parameters(tool), args, "arguments")
        .map_err(|m| ToolError::new(INVALID_INPUT, m))
}

/// Maps a registry summary row to the tool vocabulary and, for `stopped`, the reason.
pub fn status_of(summary: &Value) -> (&'static str, Option<&'static str>) {
    if summary["pause"].as_str() == Some("paused") {
        return ("paused", None);
    }
    match summary["status"].as_str() {
        Some("working") => ("working", None),
        Some("needs-you") => ("waiting-for-approval", None),
        Some("idle") => ("idle", None),
        _ => ("stopped", Some(stop_reason_of(summary))),
    }
}

fn stop_reason_of(summary: &Value) -> &'static str {
    let raw = summary["stopReason"].as_str();
    // With no live process the registry only knows `not-started`; a recorded stop request is the
    // more specific truth.
    if matches!(raw, None | Some("not-started"))
        && summary["stoppedOnRequestConversation"].as_str().is_some()
    {
        return "stopped-on-request";
    }
    STOP_REASONS
        .iter()
        .find(|r| Some(**r) == raw)
        .copied()
        .unwrap_or("agent-exited")
}

fn text<'a>(summary: &'a Value, key: &str) -> &'a str {
    summary[key].as_str().unwrap_or_default()
}

fn project_of(summary: &Value, repositories: &[(String, String)]) -> Value {
    let id = text(summary, "repositoryId");
    let name = repositories
        .iter()
        .find(|(repo_id, _)| repo_id == id)
        .map_or("", |(_, name)| name.as_str());
    json!({ "id": id, "name": name })
}

fn row(summary: &Value, repositories: &[(String, String)], self_id: &str) -> Value {
    let id = text(summary, "id");
    let mut row = Map::new();
    row.insert("id".into(), id.into());
    row.insert("name".into(), text(summary, "name").into());
    row.insert("project".into(), project_of(summary, repositories));
    row.insert("branch".into(), text(summary, "branch").into());
    row.insert("status".into(), status_of(summary).0.into());
    row.insert("archived".into(), summary["archivedAt"].is_string().into());
    row.insert(
        "lastActivityAt".into(),
        text(summary, "lastActivityAt").into(),
    );
    if id == self_id {
        row.insert("self".into(), true.into());
    }
    if summary["hiddenAt"].is_string() {
        row.insert("hidden".into(), true.into());
    }
    Value::Object(row)
}

fn matches_project(summary: &Value, repositories: &[(String, String)], wanted: &str) -> bool {
    let repo_id = text(summary, "repositoryId");
    repo_id == wanted
        || repositories
            .iter()
            .any(|(id, name)| id == repo_id && name.eq_ignore_ascii_case(wanted))
}

/// The `refract_list_sessions` result. Rows stay newest-activity first; over the byte cap the
/// oldest rows go, never the caller's own.
pub fn list_value(
    summaries: &[Value],
    repositories: &[(String, String)],
    self_id: &str,
    project: Option<&str>,
    include_archived: bool,
) -> Result<Value, ToolError> {
    if let Some(wanted) = project {
        let known = repositories
            .iter()
            .any(|(id, name)| id == wanted || name.eq_ignore_ascii_case(wanted));
        if !known {
            return Err(ToolError::new(
                UNKNOWN_PROJECT,
                format!("{wanted} is not a Refract project id or name"),
            ));
        }
    }
    let mut chosen: Vec<&Value> = summaries
        .iter()
        .filter(|s| include_archived || !s["archivedAt"].is_string())
        .filter(|s| project.is_none_or(|p| matches_project(s, repositories, p)))
        .collect();
    chosen.sort_by(|a, b| text(b, "lastActivityAt").cmp(text(a, "lastActivityAt")));
    let total = chosen.len();
    let mut rows: Vec<Value> = chosen
        .iter()
        .map(|s| row(s, repositories, self_id))
        .collect();
    let mut truncated = false;
    while rows.len() > 1 && result(&rows, total, truncated).to_string().len() > MAX_RESULT_BYTES {
        let drop = rows.iter().rposition(|r| r["self"] != true).unwrap_or(0);
        rows.remove(drop);
        truncated = true;
    }
    Ok(result(&rows, total, truncated))
}

fn result(rows: &[Value], total: usize, truncated: bool) -> Value {
    let mut out = json!({ "sessions": rows, "total": total });
    if truncated {
        out["truncated"] = true.into();
    }
    out
}

/// The `refract_get_session_status` result; `pull_request` is already `{ number, url }` or null.
pub fn status_value(
    summary: &Value,
    repositories: &[(String, String)],
    pull_request: Value,
) -> Value {
    let (status, stop_reason) = status_of(summary);
    let mut out = json!({
        "id": text(summary, "id"),
        "name": text(summary, "name"),
        "project": project_of(summary, repositories),
        "status": status,
        "archived": summary["archivedAt"].is_string(),
        "hidden": summary["hiddenAt"].is_string(),
        "branch": text(summary, "branch"),
        "pullRequest": pull_request,
        "lastActivityAt": text(summary, "lastActivityAt"),
    });
    if let Some(reason) = stop_reason {
        out["stopReason"] = reason.into();
    }
    out
}

fn repository_names(registry: &crate::store::registry::Registry) -> Vec<(String, String)> {
    registry
        .repositories
        .iter()
        .map(|r| (r.id.clone(), r.name.clone()))
        .collect()
}

fn manager_gone() -> ToolError {
    ToolError::new(
        super::router::CANCELLED,
        "Refract is shutting down; no Session can be reached",
    )
}

pub async fn list(agent: &SessionAgent, args: &Value) -> Result<Value, ToolError> {
    check_args(LIST_SESSIONS, args)?;
    let manager = agent.tool_manager().ok_or_else(manager_gone)?;
    let repositories = repository_names(&manager.registry_snapshot().await);
    let summaries = manager.summaries().await;
    list_value(
        &summaries,
        &repositories,
        agent.tool_session_id(),
        args["project"].as_str(),
        args["include_archived"].as_bool().unwrap_or(false),
    )
}

pub async fn get_status(agent: &SessionAgent, args: &Value) -> Result<Value, ToolError> {
    check_args(GET_SESSION_STATUS, args)?;
    let id = args["id"].as_str().unwrap_or_default();
    if id.is_empty() {
        return Err(ToolError::new(INVALID_INPUT, "id must not be empty"));
    }
    let manager = agent.tool_manager().ok_or_else(manager_gone)?;
    let summaries = manager.summaries().await;
    let summary = summaries
        .iter()
        .find(|s| text(s, "id") == id)
        .ok_or_else(|| ToolError::new(NOT_FOUND, format!("no Session has id {id}")))?;
    let repositories = repository_names(&manager.registry_snapshot().await);
    let target = manager.get_agent(id);
    let pull_request = crate::session::readout::pull_request_link(
        target.as_deref(),
        id,
        text(summary, "worktreePath"),
        text(summary, "branch"),
    )
    .await;
    Ok(status_value(summary, &repositories, pull_request))
}

#[cfg(test)]
#[path = "sessions.test.rs"]
mod tests;
