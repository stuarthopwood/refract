// `refract_create_session` (#1859): a Session makes a child Session. The checks run in the
// contract's order, the developer approves unless the caller runs in `yolo`, then the row, the
// agent and the first turn are made. The core is generic over `Host` so the races are testable.

use std::sync::Arc;

use serde_json::{json, Value};

use super::approval;
use super::panels;
use super::router::{approval_outcome, ToolError, CANCELLED, INVALID_INPUT};
use super::sessions::{live_status, manager_gone, NOT_FOUND};
use super::sessions_send::MAX_TEXT_BYTES;
use super::tree_gate;
use crate::git::worktrees::list_branches;
use crate::ipc::sessions_lifecycle::create_session_record_on_listed_base;
use crate::session::agent::{PendingRequest, SessionAgent, SharedRegistry};
use crate::store::registry::Session;
use crate::store::session_tree::validate_parent;

pub const CREATE_SESSION: &str = "refract_create_session";
pub const START_FAILED: &str = "start_failed";
pub const SESSION_LIMIT: &str = "session_limit";
/// Live (unarchived) Sessions one Project may hold before an agent can make another (#1859).
pub const MAX_LIVE_SESSIONS: usize = 6;
const PREVIEW_CHARS: usize = 150;

pub fn description() -> &'static str {
    "Create a child Session: its own Worktree and branch, a running agent, and your prompt as its \
first turn. Rule of thumb: a bounded report is a subagent (OMP `task`, async); the same work in \
parallel is a background agent; an own-branch, long-lived, user-visible piece of work is a child \
Session. Depth is at most 3, a parent has at most 4 live children, and a Project at most 6 live Sessions. The child reports back with \
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

/// What `create` needs from the running app; a fake stands in for it in tests. The calls the
/// post-approval task makes are `Send`, because that task is spawned (see `create_with`).
pub(super) trait Host: Send + Sync + 'static {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    async fn is_yolo(&self) -> bool;
    /// Raises the card and waits: `Ok` only when the developer approved.
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError>;
    async fn known_roles(&self) -> Result<Vec<String>, ToolError>;
    /// Starts the agent, applies `role`, then sends the first turn.
    fn start(
        &self,
        id: &str,
        role: Option<&str>,
        first_turn: String,
    ) -> impl std::future::Future<Output = Result<(), ToolError>> + Send;
    fn status(&self, id: &str) -> impl std::future::Future<Output = String> + Send;
}

enum ParentArg {
    Caller,
    Root,
    Id(String),
}

struct Request {
    prompt: String,
    name: Option<String>,
    base_branch: Option<String>,
    role: Option<String>,
    parent: ParentArg,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

fn parse(args: &Value) -> Result<Request, ToolError> {
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
        Some(Value::String(id)) => ParentArg::Id(id.clone()),
        Some(_) => return Err(invalid("parent_id must be a string or null")),
    };
    Ok(Request {
        prompt: prompt.to_string(),
        name: name.map(str::to_string),
        base_branch: args["base_branch"].as_str().map(str::to_string),
        role: args["role"].as_str().map(str::to_string),
        parent,
    })
}

/// The parent, or `None` for a root, after the existence, archived and same-Project checks. A
/// default parent is the caller, which must not be archived either: it is the same parent.
fn resolve_parent<'a>(
    sessions: &'a [Session],
    caller: &'a Session,
    parent: &ParentArg,
) -> Result<Option<&'a Session>, ToolError> {
    let id = match parent {
        ParentArg::Root => return Ok(None),
        ParentArg::Caller => {
            if caller.archived_at.is_some() {
                return Err(invalid(format!("Session {} is archived", caller.id)));
            }
            return Ok(Some(caller));
        }
        ParentArg::Id(id) => id.as_str(),
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

/// The parent's `(name, id)` after every check that depends on the registry: the parent, the
/// tree limits and the Project cap. Run before the card and again under the gate, so a change
/// made while the card was open cannot slip through.
fn check_tree(
    sessions: &[Session],
    caller: &Session,
    request: &Request,
) -> Result<Option<(String, String)>, ToolError> {
    let parent = resolve_parent(sessions, caller, &request.parent)?;
    if let Some(parent) = parent {
        validate_parent(sessions, None, &parent.id).map_err(|e| tree_error(&parent.id, e))?;
    }
    let live = sessions
        .iter()
        .filter(|s| s.repository_id == caller.repository_id && s.archived_at.is_none())
        .count();
    if live >= MAX_LIVE_SESSIONS {
        return Err(ToolError::new(
            SESSION_LIMIT,
            format!(
                "this Project already has {live} live Sessions; the limit is {MAX_LIVE_SESSIONS}"
            ),
        ));
    }
    Ok(parent.map(|p| (p.name.clone(), p.id.clone())))
}

async fn sessions_of(host: &impl Host) -> Vec<Session> {
    host.registry().lock().await.snapshot().sessions
}

/// A name inside the quoted parent line: no quotes to break out of it, and flattened like a card
/// line (no line breaks or invisible format characters).
fn plain(name: &str) -> String {
    approval::flatten(&name.replace(['"', '\''], ""))
}

/// The text the child's first turn carries; a root Session gets the bare prompt.
pub fn first_turn(parent: Option<(&str, &str)>, prompt: &str) -> String {
    match parent {
        Some((name, id)) => format!(
            "[Parent Session: \"{}\" (id {id}). When you finish, report back with \
refract_send_session_message to that id.]\n\n{prompt}",
            plain(name)
        ),
        None => prompt.to_string(),
    }
}

/// What the post-approval task needs, all owned so the task outlives a cancelled call.
struct Commit {
    request: Request,
    repository_id: String,
    base: String,
}

async fn create_with<H: Host>(host: &Arc<H>, args: &Value) -> Result<Value, ToolError> {
    let request = parse(args)?;
    let sessions = sessions_of(&**host).await;
    let caller = sessions
        .iter()
        .find(|s| s.id == host.caller_id())
        .ok_or_else(caller_gone)?;
    if let Some(role) = &request.role {
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
        .clone()
        .unwrap_or_else(|| repository.default_branch.clone());
    let branches = list_branches(std::path::Path::new(&repository.path))
        .await
        .map_err(|e| ToolError::new(e.code.as_str(), e.message))?;
    if !branches.contains(&base) {
        return Err(invalid(format!("branch {base} does not exist")));
    }
    let parent = check_tree(&sessions, caller, &request)?;

    if !host.is_yolo().await {
        let target = parent.as_ref().map_or_else(
            || format!("{}: new root Session", repository.name),
            |(name, _)| format!("{}: new child of {name}", repository.name),
        );
        let mut details = vec![format!("Base branch: {base}")];
        if let Some(name) = &request.name {
            details.push(format!("Name: {name}"));
        }
        if let Some(role) = &request.role {
            details.push(format!("Role: {role}"));
        }
        details.push(START_MODE_LINE.to_string());
        details.push(preview(&request.prompt));
        host.ask(approval::session_card(
            host.call_id(),
            CREATE_SESSION,
            target,
            details,
        ))
        .await?;
    }

    // Spawned and awaited: a cancelled call (`host_tool_cancel`, shutdown) drops only this wait,
    // so the Worktree, the row and the start are never left half done.
    let commit = Commit {
        request,
        repository_id: repository.id,
        base,
    };
    tokio::spawn(commit_create(host.clone(), commit))
        .await
        .unwrap_or_else(|e| Err(ToolError::new(CANCELLED, format!("create task ended: {e}"))))
}

/// Gate, re-check, record, rename, start. The checks run again under the gate: the caller or the
/// parent may have changed, or a racing create may have taken the last slot, while the card was open.
async fn commit_create<H: Host>(host: Arc<H>, commit: Commit) -> Result<Value, ToolError> {
    let Commit {
        request,
        repository_id,
        base,
    } = commit;
    let gate = tree_gate::lock(&repository_id).await;
    let sessions = sessions_of(&*host).await;
    let caller = sessions
        .iter()
        .find(|s| s.id == host.caller_id())
        .ok_or_else(caller_gone)?;
    let parent = check_tree(&sessions, caller, &request)?;
    let parent_id = parent.as_ref().map(|(_, id)| id.clone());
    let created = create_session_record_on_listed_base(
        host.registry(),
        &repository_id,
        &base,
        parent_id.clone(),
    )
    .await
    .map_err(|e| match e.code {
        "base-missing" => invalid(e.message),
        "not-found" => ToolError::new(NOT_FOUND, e.message),
        code => ToolError::new(code, e.message),
    })?;
    drop(gate);

    let (name, warning) = apply_name(host.registry(), &created, request.name.as_deref()).await;
    let turn = first_turn(
        parent.as_ref().map(|(n, i)| (n.as_str(), i.as_str())),
        &request.prompt,
    );
    host.start(&created.id, request.role.as_deref(), turn)
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
    if let Some(warning) = warning {
        out["warning"] = warning.into();
    }
    Ok(out)
}

/// The Session's final name, and a warning when the requested one could not be saved: the
/// Session exists either way, so a failed rename must not fail the call or go unmentioned.
async fn apply_name(
    registry: &SharedRegistry,
    created: &Session,
    wanted: Option<&str>,
) -> (String, Option<String>) {
    let Some(wanted) = wanted else {
        return (created.name.clone(), None);
    };
    match registry
        .lock()
        .await
        .update_session_name(&created.id, wanted.to_string())
        .await
    {
        Ok(renamed) => (renamed.name, None),
        Err(e) => (
            created.name.clone(),
            Some(format!(
                "could not rename the Session to the requested name ({e:?}); it keeps the generated name {}",
                created.name
            )),
        ),
    }
}

const START_MODE_LINE: &str =
    "Starts in: the app's current approval mode (not inherited from this Session)";

/// The card's prompt line: the first characters, the total length, and "(truncated)" when cut.
fn preview(prompt: &str) -> String {
    let total = prompt.chars().count();
    match prompt.char_indices().nth(PREVIEW_CHARS) {
        Some((end, _)) => format!(
            "Prompt ({total} characters, truncated): {}…",
            &prompt[..end]
        ),
        None => format!("Prompt ({total} characters): {prompt}"),
    }
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
    async fn start(
        &self,
        id: &str,
        role: Option<&str>,
        first_turn: String,
    ) -> Result<(), ToolError> {
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
        live_status(&self.manager, id).await.to_string()
    }
}

pub async fn create(
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
    create_with(&host, args).await
}

#[cfg(test)]
#[path = "sessions_create.test.rs"]
mod tests;
