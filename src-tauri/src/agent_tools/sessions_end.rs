// Shared parts of the Session end tools: archive, unarchive, stop, pause, resume and delete.
// Argument parsing, the target guard, the approval table, and the `EndHost` the actions run on, so
// every tool refuses the same way and a fake host can stand in for the running app in tests.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;

use serde_json::Value;

use super::approval;
use super::panels;
use super::router::{approval_outcome, ToolError, CANCELLED, INVALID_INPUT};
use super::sessions::{live_status, manager_gone, NOT_FOUND};
use super::sessions_send::INVALID_TARGET;
use crate::session::agent::{PendingRequest, SessionAgent, SharedRegistry};
use crate::store::registry::Session;

pub const INVALID_STATE: &str = "invalid_state";
pub const CHILD_LIMIT: &str = "child_limit";
pub const DELETE_REFUSED: &str = "delete_refused";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndTool {
    Archive,
    Unarchive,
    Stop,
    Pause,
    Resume,
    Delete,
}

impl EndTool {
    pub const ALL: [EndTool; 6] = [
        EndTool::Archive,
        EndTool::Unarchive,
        EndTool::Stop,
        EndTool::Pause,
        EndTool::Resume,
        EndTool::Delete,
    ];

    pub fn name(self) -> &'static str {
        match self {
            EndTool::Archive => "refract_archive_session",
            EndTool::Unarchive => "refract_unarchive_session",
            EndTool::Stop => "refract_stop_session",
            EndTool::Pause => "refract_pause_session",
            EndTool::Resume => "refract_resume_session",
            EndTool::Delete => "refract_delete_session",
        }
    }

    fn verb(self) -> &'static str {
        match self {
            EndTool::Archive => "Archive",
            EndTool::Unarchive => "Unarchive",
            EndTool::Stop => "Stop",
            EndTool::Pause => "Pause",
            EndTool::Resume => "Resume",
            EndTool::Delete => "Delete",
        }
    }
}

/// The checked arguments of one end tool call.
#[derive(Debug, PartialEq, Eq)]
pub struct EndArgs {
    pub id: String,
    pub include_children: bool,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

/// `id` is a non-empty string; `include_children` is a boolean and only archive takes it. Any
/// other key is refused rather than ignored, so a typo never silently changes the scope.
pub fn parse_args(tool: EndTool, args: &Value) -> Result<EndArgs, ToolError> {
    let allowed: &[&str] = if tool == EndTool::Archive {
        &["id", "include_children"]
    } else {
        &["id"]
    };
    panels::validate_keys(args, allowed).map_err(invalid)?;
    let id = match args.get("id") {
        Some(Value::String(id)) if !id.trim().is_empty() => id.clone(),
        _ => return Err(invalid("id must be a non-empty string")),
    };
    let include_children = match args.get("include_children") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(invalid("include_children must be a boolean")),
    };
    Ok(EndArgs {
        id,
        include_children,
    })
}

/// Parent chain above `id`, nearest first. A loop or a parent missing from the registry ends the
/// walk, so bad data cannot spin it.
pub fn ancestors_of<'a>(sessions: &'a [Session], id: &str) -> Vec<&'a str> {
    let mut seen: HashSet<&str> = HashSet::from([id]);
    let mut found = Vec::new();
    let mut current = sessions.iter().find(|s| s.id == id);
    while let Some(parent) = current
        .and_then(|s| s.parent_session_id.as_deref())
        .and_then(|parent| sessions.iter().find(|s| s.id == parent))
    {
        if !seen.insert(parent.id.as_str()) {
            break;
        }
        found.push(parent.id.as_str());
        current = Some(parent);
    }
    found
}

/// The target row, or why the caller may not act on it: unknown or other-Project Sessions are
/// `not_found`; the caller itself, any ancestor, and the Personal Agent are `invalid_target`.
pub fn refuse_target<'a>(
    sessions: &'a [Session],
    caller: &str,
    target: &str,
) -> Result<&'a Session, ToolError> {
    let caller_row = sessions
        .iter()
        .find(|s| s.id == caller)
        .ok_or_else(|| ToolError::new(CANCELLED, "the calling Session no longer exists"))?;
    let not_found = || ToolError::new(NOT_FOUND, format!("no Session has id {target}"));
    let row = sessions
        .iter()
        .find(|s| s.id == target)
        .ok_or_else(not_found)?;
    if row.is_personal() {
        return Err(ToolError::new(
            INVALID_TARGET,
            "the Personal Agent cannot be changed with this tool",
        ));
    }
    if row.repository_id != caller_row.repository_id {
        return Err(not_found());
    }
    if row.id == caller {
        return Err(ToolError::new(
            INVALID_TARGET,
            "a Session cannot do this to itself; the developer can do it by hand",
        ));
    }
    if ancestors_of(sessions, caller).contains(&target) {
        return Err(ToolError::new(
            INVALID_TARGET,
            "the target is an ancestor of the calling Session; the developer can do it by hand",
        ));
    }
    Ok(row)
}

/// Archive and stop ask unless `yolo`; pause, resume and unarchive also skip the card inside the
/// caller's own tree; delete always asks.
pub fn needs_card(tool: EndTool, inside_own_tree: bool, yolo: bool) -> bool {
    match tool {
        EndTool::Delete => true,
        EndTool::Archive | EndTool::Stop => !yolo,
        EndTool::Pause | EndTool::Resume | EndTool::Unarchive => !yolo && !inside_own_tree,
    }
}

/// The card for one call. `names` is every Session the call acts on (target first); `reroots` is
/// true when a delete leaves live children behind.
pub fn card_for(tool: EndTool, call_id: &str, names: &[String], reroots: bool) -> PendingRequest {
    let first = names.first().map_or("", String::as_str);
    let (title, details) = match tool {
        EndTool::Archive if names.len() > 1 => {
            (format!("Archive {} Sessions", names.len()), names.to_vec())
        }
        EndTool::Delete => {
            let mut lines = vec!["Its worktree and Conversations are removed.".to_string()];
            if reroots {
                lines.push("Live child Sessions become root Sessions.".to_string());
            }
            (format!("Delete Session {first}"), lines)
        }
        other => (format!("{} Session {first}", other.verb()), Vec::new()),
    };
    approval::session_card(call_id, tool.name(), title, details)
}

/// What the end tools need from the running app; a fake stands in for it in tests. The calls the
/// post-approval task makes return `Send` futures, because that task is spawned.
pub(super) trait EndHost: Send + Sync + 'static {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    fn is_yolo(&self) -> impl Future<Output = bool> + Send;
    /// Raises the card and waits: `Ok` only when the developer approved.
    fn ask(&self, card: PendingRequest) -> impl Future<Output = Result<(), ToolError>> + Send;
    /// The tool-vocabulary status; `stopped` when there is no live agent.
    fn status(&self, id: &str) -> impl Future<Output = String> + Send;
    fn archive(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn restore(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn stop(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn pause(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn resume(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    /// The Delete refusals, without claiming the removal, so they run before the card.
    fn delete_precheck(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
}

/// The running app behind `EndHost`: the IPC cores for the registry actions, the agent for pause.
pub(super) struct AppEndHost {
    agent: Arc<SessionAgent>,
    call_id: String,
    manager: Arc<crate::session::SessionManager>,
    registry: SharedRegistry,
    state: crate::ipc::AppState,
}

impl AppEndHost {
    pub(super) fn new(agent: &Arc<SessionAgent>, call_id: &str) -> Result<Self, ToolError> {
        let manager = agent.tool_manager().ok_or_else(manager_gone)?;
        let state = agent.tool_app_state().ok_or_else(manager_gone)?;
        Ok(Self {
            agent: agent.clone(),
            call_id: call_id.to_string(),
            manager,
            registry: agent.tool_registry().clone(),
            state,
        })
    }

    fn target_agent(&self, id: &str) -> Result<Arc<SessionAgent>, ToolError> {
        self.manager.get_agent(id).ok_or_else(|| {
            ToolError::new(
                super::sessions_send::SESSION_NOT_RUNNING,
                "the target Session is stopped",
            )
        })
    }
}

fn ipc_error(error: crate::ipc::IpcError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn delete_error(error: crate::ipc::IpcError) -> ToolError {
    ToolError::new(DELETE_REFUSED, error.message)
}

impl EndHost for AppEndHost {
    fn caller_id(&self) -> &str {
        self.agent.tool_session_id()
    }
    fn call_id(&self) -> &str {
        &self.call_id
    }
    fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
    async fn is_yolo(&self) -> bool {
        self.agent.tool_is_yolo().await
    }
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError> {
        let rx = self
            .agent
            .tool_router()
            .wait_for(&approval::request_id(&self.call_id));
        self.agent.tool_raise_approval(card).await;
        approval_outcome(rx.await.ok())
    }
    async fn status(&self, id: &str) -> String {
        live_status(&self.manager, id).await.to_string()
    }
    async fn archive(&self, id: &str) -> Result<(), ToolError> {
        crate::ipc::sessions_lifecycle::archive_core::archive_core(&self.state, id)
            .await
            .map_err(ipc_error)
    }
    async fn restore(&self, id: &str) -> Result<(), ToolError> {
        crate::ipc::sessions_lifecycle::archive_core::restore_core(&self.state, id)
            .await
            .map_err(|e| match e.code {
                "child-limit" => ToolError::new(CHILD_LIMIT, e.message),
                _ => ipc_error(e),
            })
    }
    async fn stop(&self, id: &str) -> Result<(), ToolError> {
        crate::ipc::sessions_agent::stop_core::stop_core(&self.state, id)
            .await
            .map_err(ipc_error)
    }
    async fn pause(&self, id: &str) -> Result<(), ToolError> {
        let agent = self.target_agent(id)?;
        agent
            .pause()
            .await
            .map(|_| ())
            .map_err(|e| ToolError::new(e.code, e.message))
    }
    async fn resume(&self, id: &str) -> Result<(), ToolError> {
        let agent = self.target_agent(id)?;
        agent
            .resume()
            .await
            .map(|_| ())
            .map_err(|e| ToolError::new(e.code, e.message))
    }
    async fn delete_precheck(&self, id: &str) -> Result<(), ToolError> {
        crate::ipc::sessions_lifecycle::delete_core::delete_precheck(&self.state, id)
            .await
            .map(|_| ())
            .map_err(delete_error)
    }
    async fn delete(&self, id: &str) -> Result<(), ToolError> {
        crate::ipc::sessions_lifecycle::delete_core::delete_core(&self.state, id)
            .await
            .map_err(delete_error)
    }
}
