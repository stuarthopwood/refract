// `refract_create_session` (#1859): a Session makes a child Session. The checks run in the
// contract's order, the developer approves unless the caller runs in `yolo`, then the row, the
// agent and the first turn are made. The core is generic over `Host` so the races are testable.

use serde_json::{json, Value};

use super::approval;
use super::panels;
use super::router::{approval_outcome, ToolError, CANCELLED, INVALID_INPUT};
use super::sessions::{status_of, NOT_FOUND};
use super::sessions_send::MAX_TEXT_BYTES;
use super::tree_gate;
use crate::git::worktrees::list_branches;
use crate::ipc::sessions_lifecycle::create_session_record;
use crate::session::agent::{PendingRequest, SessionAgent, SharedRegistry};
use crate::store::registry::Session;
use crate::store::session_tree::validate_parent;

pub const CREATE_SESSION: &str = "refract_create_session";
pub const START_FAILED: &str = "start_failed";

pub fn description() -> &'static str {
    "Create a child Session: its own Worktree and branch, a running agent, and your prompt as its \
first turn. Rule of thumb: a bounded report is a subagent (OMP `task`, async); the same work in \
parallel is a background agent; an own-branch, long-lived, user-visible piece of work is a child \
Session. Depth is at most 3 and a parent has at most 4 live children. The child reports back with \
refract_send_session_message. `parent_id` defaults to you; null makes a root Session. Unless you run \
in yolo, the developer approves first."
}

pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "prompt": { "type": "string", "description": "The child's first turn, 1 byte to 32 KB." },
            "name": { "type": "string", "description": "Session name; omit for the generated one." },
            "base_branch": { "type": "string", "description": "Branch to cut the Worktree from; omit for the Project default." },
            "role": { "type": "string", "description": "Model role; omit for the Project default. Never inherited." },
            "parent_id": { "type": ["string", "null"], "description": "Parent Session id; omit for yourself, null for a root Session." }
        },
        "required": ["prompt"],
        "additionalProperties": false
    })
}

/// What `create` needs from the running app; a fake stands in for it in tests.
pub(super) trait Host {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    async fn is_yolo(&self) -> bool;
    /// Raises the card and waits: `Ok` only when the developer approved.
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError>;
    async fn known_roles(&self) -> Result<Vec<String>, ToolError>;
    /// Starts the agent, applies `role`, then sends the first turn.
    async fn start(&self, id: &str, role: Option<&str>, first_turn: String) -> Result<(), ToolError>;
    async fn status(&self, id: &str) -> String;
}

enum ParentArg<'a> {
    Caller,
    Root,
    Id(&'a str),
}

struct Request<'a> {
    prompt: &'a str,
    name: Option<&'a str>,
    base_branch: Option<&'a str>,
    role: Option<&'a str>,
    parent: ParentArg<'a>,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

fn parse(args: &Value) -> Result<Request<'_>, ToolError> {
    panels::validate(&parameters(), args, "arguments").map_err(invalid)?;
    let prompt = args["prompt"].as_str().unwrap_or_default();
    if prompt.trim().is_empty() {
        return Err(invalid("prompt must not be empty"));
    }
    if prompt.len() > MAX_TEXT_BYTES {
        return Err(invalid(format!(
            "prompt is {} bytes; the limit is {MAX_TEXT_BYTES}",
            prompt.len()
        )));
    }
    let name = args["name"].as_str();
    if name.is_some_and(|n| n.trim().is_empty()) {
        return Err(invalid("name must not be empty"));
    }
    let parent = match args.get("parent_id") {
        None => ParentArg::Caller,
        Some(Value::Null) => ParentArg::Root,
        Some(Value::String(id)) => ParentArg::Id(id),
        Some(_) => return Err(invalid("parent_id must be a string or null")),
    };
    Ok(Request {
        prompt,
        name,
        base_branch: args["base_branch"].as_str(),
        role: args["role"].as_str(),
        parent,
    })
}

/// The parent's id, or `None` for a root, after the existence and same-Project checks.
fn resolve_parent<'a>(
    sessions: &'a [Session],
    caller: &'a Session,
    parent: &ParentArg<'a>,
) -> Result<Option<&'a Session>, ToolError> {
    let id = match parent {
        ParentArg::Root => return Ok(None),
        ParentArg::Caller => return Ok(Some(caller)),
        ParentArg::Id(id) => *id,
    };
    let found = sessions
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| ToolError::new(NOT_FOUND, format!("no Session has id {id}")))?;
    if found.archived_at.is_some() {
        return Err(invalid(format!("Session {id} is archived")));
    }
    if found.repository_id != caller.repository_id {
        return Err(invalid(format!("Session {id} is in another Project")));
    }
    Ok(Some(found))
}

fn tree_error(parent: &str, error: crate::store::session_tree::TreeError) -> ToolError {
    ToolError::new(
        tree_gate::error_code(error),
        format!("Session {parent} cannot take another child ({error:?})"),
    )
}

fn caller_gone() -> ToolError {
    ToolError::new(
        CANCELLED,
        "the calling Session was deleted before the new Session was made",
    )
}

async fn sessions_of(host: &impl Host) -> Vec<Session> {
    host.registry().lock().await.snapshot().sessions
}

/// The text the child's first turn carries; a root Session gets the bare prompt.
pub fn first_turn(parent: Option<(&str, &str)>, prompt: &str) -> String {
    match parent {
        Some((name, id)) => format!(
            "[Parent Session: \"{name}\" (id {id}). When you finish, report back with \
refract_send_session_message to that id.]\n\n{prompt}"
        ),
        None => prompt.to_string(),
    }
}

async fn create_with(host: &impl Host, args: &Value) -> Result<Value, ToolError> {
    let request = parse(args)?;
    let sessions = sessions_of(host).await;
    let caller = sessions
        .iter()
        .find(|s| s.id == host.caller_id())
        .ok_or_else(caller_gone)?;
    if let Some(role) = request.role {
        if !host.known_roles().await?.iter().any(|r| r == role) {
            return Err(invalid(format!("{role} is not a known role")));
        }
    }
    let repository = host
        .registry()
        .lock()
        .await
        .get_repository(&caller.repository_id)
        .cloned()
        .ok_or_else(|| ToolError::new(NOT_FOUND, "the caller's Project no longer exists"))?;
    let base = request
        .base_branch
        .unwrap_or(&repository.default_branch)
        .to_string();
    let branches = list_branches(std::path::Path::new(&repository.path))
        .await
        .map_err(|e| ToolError::new(e.code.as_str(), e.message))?;
    if !branches.contains(&base) {
        return Err(invalid(format!("branch {base} does not exist")));
    }
    let parent = resolve_parent(&sessions, caller, &request.parent)?;
    if let Some(parent) = parent {
        validate_parent(&sessions, None, &parent.id).map_err(|e| tree_error(&parent.id, e))?;
    }
    let parent_ref = parent.map(|p| (p.name.clone(), p.id.clone()));

    if !host.is_yolo().await {
        let target = parent_ref.as_ref().map_or_else(
            || format!("{}: new root Session", repository.name),
            |(name, _)| format!("{}: new child of {name}", repository.name),
        );
        let mut details = vec![format!("Base branch: {base}")];
        if let Some(name) = request.name {
            details.push(format!("Name: {name}"));
        }
        if let Some(role) = request.role {
            details.push(format!("Role: {role}"));
        }
        details.push(format!("Prompt: {}", preview(request.prompt)));
        host.ask(approval::session_card(host.call_id(), CREATE_SESSION, target, details))
            .await?;
    }

    // The limits are checked again under the gate: the caller may have been deleted, or a racing
    // create may have taken the last slot, while the card was open.
    let _gate = tree_gate::lock().await;
    let sessions = sessions_of(host).await;
    if !sessions.iter().any(|s| s.id == host.caller_id()) {
        return Err(caller_gone());
    }
    let parent_id = parent_ref.as_ref().map(|(_, id)| id.clone());
    if let Some(id) = &parent_id {
        if !sessions.iter().any(|s| &s.id == id) {
            return Err(ToolError::new(NOT_FOUND, format!("no Session has id {id}")));
        }
        validate_parent(&sessions, None, id).map_err(|e| tree_error(id, e))?;
    }
    let created = create_session_record(
        host.registry(),
        &repository.id,
        &base,
        parent_id.clone(),
    )
    .await
    .map_err(|e| match e.code {
        "base-missing" => invalid(e.message),
        "not-found" => ToolError::new(NOT_FOUND, e.message),
        code => ToolError::new(code, e.message),
    })?;
    drop(_gate);

    let name = match request.name {
        Some(name) => {
            let renamed = host
                .registry()
                .lock()
                .await
                .update_session_name(&created.id, name.to_string())
                .await;
            renamed.map_or(created.name.clone(), |s| s.name)
        }
        None => created.name.clone(),
    };
    let turn = first_turn(
        parent_ref.as_ref().map(|(n, i)| (n.as_str(), i.as_str())),
        request.prompt,
    );
    host.start(&created.id, request.role, turn)
        .await
        .map_err(|e| {
            ToolError::new(
                START_FAILED,
                format!(
                    "Session {} was created but did not start: {}",
                    created.id, e.message
                ),
            )
        })?;
    let mut out = json!({
        "id": created.id,
        "name": name,
        "branch": created.branch,
        "status": host.status(&created.id).await,
    });
    if let Some(id) = parent_id {
        out["parentId"] = id.into();
    }
    Ok(out)
}

fn preview(prompt: &str) -> String {
    match prompt.char_indices().nth(200) {
        Some((end, _)) => format!("{}…", &prompt[..end]),
        None => prompt.to_string(),
    }
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
    async fn start(&self, id: &str, role: Option<&str>, first_turn: String) -> Result<(), ToolError> {
        let child = self.manager.get_or_create_agent(id);
        let fail = |e: crate::session::agent::AgentError| ToolError::new(e.code, e.message);
        child.start().await.map_err(fail)?;
        if let Some(role) = role {
            let roles = self.known_roles().await?;
            crate::session::pending_selection::choose_role(&child, role, &roles)
                .await
                .map_err(fail)?;
        }
        child.send_session_message(first_turn).await.map_err(fail)?;
        Ok(())
    }
    async fn status(&self, id: &str) -> String {
        let summaries = self.manager.summaries().await;
        summaries
            .iter()
            .find(|s| s["id"].as_str() == Some(id))
            .map_or("idle", |s| status_of(s).0)
            .to_string()
    }
}

pub async fn create(agent: &SessionAgent, call_id: &str, args: &Value) -> Result<Value, ToolError> {
    let manager = agent.tool_manager().ok_or_else(|| {
        ToolError::new(CANCELLED, "Refract is shutting down; no Session can be reached")
    })?;
    let registry = agent.tool_registry().clone();
    let host = AppHost {
        agent,
        call_id,
        manager,
        registry,
    };
    create_with(&host, args).await
}

#[cfg(test)]
#[path = "sessions_create.test.rs"]
mod tests;
