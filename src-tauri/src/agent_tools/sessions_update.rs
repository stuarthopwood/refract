// `refract_update_session` (#1859): rename a Session, change its role, or move it in the tree. No
// card inside the caller's own tree; elsewhere the developer approves unless the caller is in
// `yolo`. The core is generic over `Host` so denial and the races are testable.

use serde_json::{json, Value};

use super::approval;
use super::panels;
use super::router::{approval_outcome, ToolError, CANCELLED, INVALID_INPUT};
use super::sessions::{status_of, NOT_FOUND};
use super::sessions_send::SESSION_NOT_RUNNING;
use super::tree_gate;
use crate::session::agent::{PendingRequest, SessionAgent, SharedRegistry};
use crate::store::registry::{
    RegistryError, RegistryErrorCode, RegistryStoreError, Session, SessionPatch,
};
use crate::store::session_tree::{validate_parent, TreeError};

pub const UPDATE_SESSION: &str = "refract_update_session";

pub fn description() -> &'static str {
    "Rename a Session, change its model role, or move it in the Session tree. `parent_id` nests \
under that Session; null makes it a root; omit it to leave the position alone. Depth is at most 3 \
and a parent has at most 4 live children. Inside your own tree (you and your descendants) this \
needs no approval; elsewhere the developer approves first unless you run in yolo."
}

pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Session id from refract_list_sessions." },
            "name": { "type": "string", "description": "New Session name." },
            "role": { "type": "string", "description": "Model role to apply; the Session must be running." },
            "parent_id": { "type": ["string", "null"], "description": "New parent Session id; null makes a root." }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

/// What `update` needs from the running app; a fake stands in for it in tests.
pub(super) trait Host {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    async fn is_yolo(&self) -> bool;
    /// Raises the card and waits: `Ok` only when the developer approved.
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError>;
    async fn known_roles(&self) -> Result<Vec<String>, ToolError>;
    /// The tool-vocabulary status; `stopped` when there is no live agent.
    async fn status(&self, id: &str) -> String;
    async fn set_role(&self, id: &str, role: &str) -> Result<(), ToolError>;
}

enum ParentArg<'a> {
    Unchanged,
    Root,
    Id(&'a str),
}

struct Request<'a> {
    id: &'a str,
    name: Option<&'a str>,
    role: Option<&'a str>,
    parent: ParentArg<'a>,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

fn parse(args: &Value) -> Result<Request<'_>, ToolError> {
    panels::validate(&parameters(), args, "arguments").map_err(invalid)?;
    let name = args["name"].as_str();
    if name.is_some_and(|n| n.trim().is_empty()) {
        return Err(invalid("name must not be empty"));
    }
    let parent = match args.get("parent_id") {
        None => ParentArg::Unchanged,
        Some(Value::Null) => ParentArg::Root,
        Some(Value::String(id)) => ParentArg::Id(id),
        Some(_) => return Err(invalid("parent_id must be a string or null")),
    };
    let role = args["role"].as_str();
    if name.is_none() && role.is_none() && matches!(parent, ParentArg::Unchanged) {
        return Err(invalid("nothing to change: give name, role or parent_id"));
    }
    Ok(Request {
        id: args["id"].as_str().unwrap_or_default(),
        name,
        role,
        parent,
    })
}

fn tree_error(parent: &str, error: TreeError) -> ToolError {
    ToolError::new(
        tree_gate::error_code(error),
        format!("Session {parent} cannot take this Session ({error:?})"),
    )
}

fn not_found(id: &str) -> ToolError {
    ToolError::new(NOT_FOUND, format!("no Session has id {id}"))
}

fn caller_gone() -> ToolError {
    ToolError::new(
        CANCELLED,
        "the calling Session was deleted before the Session was updated",
    )
}

fn store_error(error: RegistryStoreError) -> ToolError {
    match error {
        RegistryStoreError::Registry(RegistryError {
            code: RegistryErrorCode::NotFound,
            message,
        }) => ToolError::new(NOT_FOUND, message),
        other => ToolError::new("registry_error", format!("{other:?}")),
    }
}

async fn sessions_of(host: &impl Host) -> Vec<Session> {
    host.registry().lock().await.snapshot().sessions
}

/// Everything that can refuse the call on the tree: existence, Project, then the tree rules.
fn check_tree(sessions: &[Session], request: &Request<'_>) -> Result<(), ToolError> {
    let target = sessions
        .iter()
        .find(|s| s.id == request.id)
        .ok_or_else(|| not_found(request.id))?;
    if let ParentArg::Id(parent_id) = request.parent {
        let parent = sessions
            .iter()
            .find(|s| s.id == parent_id)
            .ok_or_else(|| not_found(parent_id))?;
        if parent.archived_at.is_some() {
            return Err(invalid(format!("Session {parent_id} is archived")));
        }
        if parent.repository_id != target.repository_id {
            return Err(invalid(format!(
                "Session {parent_id} is in another Project"
            )));
        }
        validate_parent(sessions, Some(request.id), parent_id)
            .map_err(|e| tree_error(parent_id, e))?;
    }
    Ok(())
}

async fn update_with(host: &impl Host, args: &Value) -> Result<Value, ToolError> {
    let request = parse(args)?;
    if let Some(role) = request.role {
        if !host.known_roles().await?.iter().any(|r| r == role) {
            return Err(invalid(format!("{role} is not a known role")));
        }
    }
    let sessions = sessions_of(host).await;
    if !sessions.iter().any(|s| s.id == host.caller_id()) {
        return Err(caller_gone());
    }
    check_tree(&sessions, &request)?;

    let new_parent = match request.parent {
        ParentArg::Id(id) => Some(id),
        ParentArg::Root | ParentArg::Unchanged => None,
    };
    let inside = tree_gate::inside_own_tree(&sessions, host.caller_id(), request.id, new_parent);
    if !inside && !host.is_yolo().await {
        let target = sessions
            .iter()
            .find(|s| s.id == request.id)
            .map_or("", |s| s.name.as_str());
        let mut details = Vec::new();
        if let Some(name) = request.name {
            details.push(format!("Rename to: {name}"));
        }
        if let Some(role) = request.role {
            details.push(format!("Role: {role}"));
        }
        match request.parent {
            ParentArg::Id(id) => details.push(format!("Nest under: {id}")),
            ParentArg::Root => details.push("Make a root Session".to_string()),
            ParentArg::Unchanged => {}
        }
        let card = approval::session_card(
            host.call_id(),
            UPDATE_SESSION,
            format!("Update Session {target}"),
            details,
        );
        host.ask(card).await?;
    }

    if request.role.is_some() {
        let status = host.status(request.id).await;
        if status == "stopped" {
            return Err(ToolError::new(
                SESSION_NOT_RUNNING,
                format!("the target Session is {status}; its role cannot change"),
            ));
        }
    }

    // The tree is checked again under the gate: a racing call or a delete may have changed it
    // while the card was open.
    {
        let _gate = tree_gate::lock().await;
        let sessions = sessions_of(host).await;
        if !sessions.iter().any(|s| s.id == host.caller_id()) {
            return Err(caller_gone());
        }
        check_tree(&sessions, &request)?;
        let parent_patch = match request.parent {
            ParentArg::Unchanged => None,
            ParentArg::Root => Some(None),
            ParentArg::Id(id) => Some(Some(id.to_string())),
        };
        if parent_patch.is_some() {
            host.registry()
                .lock()
                .await
                .update_session(
                    request.id,
                    SessionPatch {
                        parent_session_id: parent_patch,
                        ..Default::default()
                    },
                )
                .await
                .map_err(store_error)?;
        }
    }
    if let Some(name) = request.name {
        host.registry()
            .lock()
            .await
            .update_session_name(request.id, name.to_string())
            .await
            .map_err(store_error)?;
    }
    if let Some(role) = request.role {
        host.set_role(request.id, role).await?;
    }

    let updated = sessions_of(host)
        .await
        .into_iter()
        .find(|s| s.id == request.id)
        .ok_or_else(|| not_found(request.id))?;
    let mut out = json!({ "id": updated.id, "name": updated.name });
    if let Some(parent) = updated.parent_session_id {
        out["parentId"] = parent.into();
    }
    Ok(out)
}

struct AppHost<'a> {
    agent: &'a SessionAgent,
    call_id: &'a str,
    manager: std::sync::Arc<crate::session::SessionManager>,
    registry: SharedRegistry,
}

impl Host for AppHost<'_> {
    fn caller_id(&self) -> &str {
        self.agent.tool_session_id()
    }
    fn call_id(&self) -> &str {
        self.call_id
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
            .wait_for(&approval::request_id(self.call_id));
        self.agent.tool_raise_approval(card).await;
        approval_outcome(rx.await.ok())
    }
    async fn known_roles(&self) -> Result<Vec<String>, ToolError> {
        crate::session::model::known_role_list()
            .await
            .map_err(|e| ToolError::new(e.code, e.message))
    }
    async fn status(&self, id: &str) -> String {
        let summaries = self.manager.summaries().await;
        summaries
            .iter()
            .find(|s| s["id"].as_str() == Some(id))
            .map_or("stopped", |s| status_of(s).0)
            .to_string()
    }
    async fn set_role(&self, id: &str, role: &str) -> Result<(), ToolError> {
        let target = self.manager.get_agent(id).ok_or_else(|| {
            ToolError::new(
                SESSION_NOT_RUNNING,
                "the target Session stopped before the role was set",
            )
        })?;
        let roles = self.known_roles().await?;
        crate::session::pending_selection::choose_role(&target, role, &roles)
            .await
            .map_err(|e| ToolError::new(e.code, e.message))?;
        Ok(())
    }
}

pub async fn update(agent: &SessionAgent, call_id: &str, args: &Value) -> Result<Value, ToolError> {
    let manager = agent.tool_manager().ok_or_else(|| {
        ToolError::new(
            CANCELLED,
            "Refract is shutting down; no Session can be reached",
        )
    })?;
    let registry = agent.tool_registry().clone();
    let host = AppHost {
        agent,
        call_id,
        manager,
        registry,
    };
    update_with(&host, args).await
}

#[cfg(test)]
#[path = "sessions_update.test.rs"]
mod tests;
