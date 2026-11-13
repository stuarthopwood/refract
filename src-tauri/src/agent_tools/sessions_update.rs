// `refract_update_session` (#1859): rename a Session, change its role, or move it in the tree. The
// target must be in the caller's Project. No card inside the caller's own tree; elsewhere in the
// Project the developer approves unless the caller is in `yolo`. The core is generic over `Host`
// so denial and the races are testable.

use std::future::Future;
use std::sync::Arc;

use serde_json::{json, Value};

use super::approval;
use super::panels;
use super::router::{approval_outcome, ToolError, CANCELLED, INVALID_INPUT};
use super::sessions::{live_status, manager_gone, NOT_FOUND};
use super::sessions_send::SESSION_NOT_RUNNING;
use super::tree_gate;
use crate::session::agent::{PendingRequest, SessionAgent, SharedRegistry};
use crate::store::registry::{
    RegistryError, RegistryErrorCode, RegistryStoreError, Session, SessionPatch,
};
use crate::store::session_tree::{validate_parent, TreeError};

pub const UPDATE_SESSION: &str = "refract_update_session";

pub fn description() -> &'static str {
    "Rename a Session, change its model role, or move it in the Session tree. The Session must be \
in your Project. `parent_id` nests under that Session; null makes it a root; omit it to leave the \
position alone. Depth is at most 3 and a parent has at most 4 live children. Inside your own tree \
(you and your descendants) this needs no approval; elsewhere in the Project the developer approves \
first unless you run in yolo."
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

/// What `update` needs from the running app; a fake stands in for it in tests. The calls the
/// post-approval task makes are `Send`, because that task is spawned (see `update_with`).
pub(super) trait Host: Send + Sync + 'static {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    fn is_yolo(&self) -> impl Future<Output = bool> + Send;
    /// Raises the card and waits: `Ok` only when the developer approved.
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError>;
    async fn known_roles(&self) -> Result<Vec<String>, ToolError>;
    /// The tool-vocabulary status; `stopped` when there is no live agent.
    fn status(&self, id: &str) -> impl Future<Output = String> + Send;
    fn set_role(&self, id: &str, role: &str) -> impl Future<Output = Result<(), ToolError>> + Send;
}

enum ParentArg {
    Unchanged,
    Root,
    Id(String),
}

/// Owned, so the post-approval task can outlive the call that built it.
struct Request {
    id: String,
    name: Option<String>,
    role: Option<String>,
    parent: ParentArg,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

fn parse(args: &Value) -> Result<Request, ToolError> {
    panels::validate(&parameters(), args, "arguments").map_err(invalid)?;
    let name = args["name"].as_str();
    if name.is_some_and(|n| n.trim().is_empty()) {
        return Err(invalid("name must not be empty"));
    }
    let parent = match args.get("parent_id") {
        None => ParentArg::Unchanged,
        Some(Value::Null) => ParentArg::Root,
        Some(Value::String(id)) => ParentArg::Id(id.clone()),
        Some(_) => return Err(invalid("parent_id must be a string or null")),
    };
    let role = args["role"].as_str();
    if name.is_none() && role.is_none() && matches!(parent, ParentArg::Unchanged) {
        return Err(invalid("nothing to change: give name, role or parent_id"));
    }
    Ok(Request {
        id: args["id"].as_str().unwrap_or_default().to_string(),
        name: name.map(str::to_string),
        role: role.map(str::to_string),
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

/// Everything that can refuse the call on the tree: the caller, the target, the Project, then
/// the tree rules.
fn check_tree(sessions: &[Session], caller_id: &str, request: &Request) -> Result<(), ToolError> {
    let caller = sessions
        .iter()
        .find(|s| s.id == caller_id)
        .ok_or_else(caller_gone)?;
    let target = sessions
        .iter()
        .find(|s| s.id == request.id)
        .ok_or_else(|| not_found(&request.id))?;
    if target.repository_id != caller.repository_id {
        return Err(invalid(format!(
            "Session {} is in another Project; you can only update Sessions in your own",
            request.id
        )));
    }
    if let ParentArg::Id(parent_id) = &request.parent {
        let parent = sessions
            .iter()
            .find(|s| s.id == *parent_id)
            .ok_or_else(|| not_found(parent_id))?;
        if parent.archived_at.is_some() {
            return Err(invalid(format!("Session {parent_id} is archived")));
        }
        if parent.repository_id != target.repository_id {
            return Err(invalid(format!(
                "Session {parent_id} is in another Project"
            )));
        }
        validate_parent(sessions, Some(&request.id), parent_id)
            .map_err(|e| tree_error(parent_id, e))?;
    }
    Ok(())
}

async fn update_with<H: Host>(host: &Arc<H>, args: &Value) -> Result<Value, ToolError> {
    let request = parse(args)?;
    if let Some(role) = &request.role {
        if !host.known_roles().await?.iter().any(|r| r == role) {
            return Err(invalid(format!("{role} is not a known role")));
        }
    }
    let sessions = sessions_of(&**host).await;
    check_tree(&sessions, host.caller_id(), &request)?;

    let mut asked = false;
    if !inside_own_tree(&sessions, &**host, &request) && !host.is_yolo().await {
        let target = sessions
            .iter()
            .find(|s| s.id == request.id)
            .map_or("", |s| s.name.as_str());
        let mut details = Vec::new();
        if let Some(name) = &request.name {
            details.push(format!("Rename to: {name}"));
        }
        if let Some(role) = &request.role {
            details.push(format!("Role: {role}"));
        }
        match &request.parent {
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
        asked = true;
    }

    let repository_id = sessions
        .iter()
        .find(|s| s.id == request.id)
        .map(|s| s.repository_id.clone())
        .ok_or_else(|| not_found(&request.id))?;
    // Spawned and awaited: a cancelled call (`host_tool_cancel`, shutdown) drops only this wait,
    // so the role, the parent and the name are never left half written.
    tokio::spawn(commit_update(host.clone(), request, repository_id, asked))
        .await
        .unwrap_or_else(|e| Err(ToolError::new(CANCELLED, format!("update task ended: {e}"))))
}

/// The writes after approval. The tree is checked again under the gate: a racing call or a
/// delete may have changed it while the card was open. The role goes first, so a role failure
/// leaves nothing written.
async fn commit_update<H: Host>(
    host: Arc<H>,
    request: Request,
    repository_id: String,
    asked: bool,
) -> Result<Value, ToolError> {
    if request.role.is_some() {
        let status = host.status(&request.id).await;
        if status == "stopped" {
            return Err(ToolError::new(
                SESSION_NOT_RUNNING,
                format!("the target Session is {status}; its role cannot change"),
            ));
        }
    }

    {
        let _gate = tree_gate::lock(&repository_id).await;
        let sessions = sessions_of(&*host).await;
        check_tree(&sessions, host.caller_id(), &request)?;
        // No card was shown because the target was inside the own tree; if it no longer is,
        // the developer never saw this change, so it is refused rather than applied.
        if !asked && !inside_own_tree(&sessions, &*host, &request) && !host.is_yolo().await {
            return Err(ToolError::new(
                CANCELLED,
                "the Session moved out of your own tree while the update ran; nothing was changed, call again to be asked",
            ));
        }
        if let Some(role) = &request.role {
            host.set_role(&request.id, role).await?;
        }
        let parent_patch = match &request.parent {
            ParentArg::Unchanged => None,
            ParentArg::Root => Some(None),
            ParentArg::Id(id) => Some(Some(id.clone())),
        };
        if parent_patch.is_some() {
            host.registry()
                .lock()
                .await
                .update_session(
                    &request.id,
                    SessionPatch {
                        parent_session_id: parent_patch,
                        ..Default::default()
                    },
                )
                .await
                .map_err(store_error)?;
        }
    }
    if let Some(name) = &request.name {
        host.registry()
            .lock()
            .await
            .update_session_name(&request.id, name.clone())
            .await
            .map_err(store_error)?;
    }

    let updated = sessions_of(&*host)
        .await
        .into_iter()
        .find(|s| s.id == request.id)
        .ok_or_else(|| not_found(&request.id))?;
    let mut out = json!({ "id": updated.id, "name": updated.name });
    if let Some(parent) = updated.parent_session_id {
        out["parentId"] = parent.into();
    }
    Ok(out)
}

fn inside_own_tree(sessions: &[Session], host: &impl Host, request: &Request) -> bool {
    let new_parent = match &request.parent {
        ParentArg::Id(id) => Some(id.as_str()),
        ParentArg::Root | ParentArg::Unchanged => None,
    };
    tree_gate::inside_own_tree(sessions, host.caller_id(), &request.id, new_parent)
}

struct AppHost {
    agent: Arc<SessionAgent>,
    call_id: String,
    manager: Arc<crate::session::SessionManager>,
    registry: SharedRegistry,
}

impl Host for AppHost {
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
    async fn known_roles(&self) -> Result<Vec<String>, ToolError> {
        crate::session::model::known_role_list()
            .await
            .map_err(|e| ToolError::new(e.code, e.message))
    }
    async fn status(&self, id: &str) -> String {
        live_status(&self.manager, id).await.to_string()
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

pub async fn update(
    agent: &Arc<SessionAgent>,
    call_id: &str,
    args: &Value,
) -> Result<Value, ToolError> {
    let manager = agent.tool_manager().ok_or_else(manager_gone)?;
    let registry = agent.tool_registry().clone();
    let host = Arc::new(AppHost {
        agent: agent.clone(),
        call_id: call_id.to_string(),
        manager,
        registry,
    });
    update_with(&host, args).await
}

#[cfg(test)]
#[path = "sessions_update.test.rs"]
mod tests;
