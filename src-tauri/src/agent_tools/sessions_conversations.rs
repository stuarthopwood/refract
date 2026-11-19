// The Conversation tools (#1861): list, new and switch, and what they share: argument checks,
// target resolution, the state and approval gate, and the defer-or-run step.

use std::future::Future;
use std::sync::Arc;

use serde_json::{json, Value};

use super::approval;
use super::handoff_target::{check_target, needs_card, Relationship};
use super::panels;
use super::router::{approval_outcome, ToolError, INVALID_INPUT, OUTCOME_UNKNOWN};
use super::sessions::{manager_gone, NOT_FOUND};
use super::sessions_end::{ipc_error, labels_for, CardLabel, INVALID_STATE};
use super::sessions_send::{MAX_TEXT_BYTES, SESSION_NOT_RUNNING};
use super::tree_gate;
use crate::session::agent::{
    FirstMessage, HandoffAction, PendingRequest, QueueOutcome, SessionAgent, SharedRegistry,
};
use crate::store::registry::Session;

pub const LIST_CONVERSATIONS: &str = "refract_list_conversations";
pub const NEW_CONVERSATION: &str = "refract_new_conversation";
pub const SWITCH_CONVERSATION: &str = "refract_switch_conversation";

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;
const PREVIEW_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvTool {
    List,
    New,
    Switch,
}

impl ConvTool {
    pub const ALL: [ConvTool; 3] = [ConvTool::List, ConvTool::New, ConvTool::Switch];

    pub fn name(self) -> &'static str {
        match self {
            ConvTool::List => LIST_CONVERSATIONS,
            ConvTool::New => NEW_CONVERSATION,
            ConvTool::Switch => SWITCH_CONVERSATION,
        }
    }
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_INPUT, message)
}

fn invalid_state(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_STATE, message)
}

/// `session_id`, when given, is a non-empty string.
fn optional_session_id(args: &Value) -> Result<Option<String>, ToolError> {
    match args.get("session_id") {
        None => Ok(None),
        Some(Value::String(id)) if !id.trim().is_empty() => Ok(Some(id.clone())),
        Some(_) => Err(invalid("session_id must be a non-empty string")),
    }
}

fn required_string(args: &Value, key: &str) -> Result<String, ToolError> {
    match args.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.clone()),
        _ => Err(invalid(format!("{key} must be a non-empty string"))),
    }
}

/// `limit` is a whole number from 1 to 100; absent means 20.
pub fn parse_list(args: &Value) -> Result<(Option<String>, usize), ToolError> {
    panels::validate_keys(args, &["session_id", "limit"]).map_err(invalid)?;
    let limit = match args.get("limit") {
        None => DEFAULT_LIMIT,
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| (1..=MAX_LIMIT).contains(n))
            .ok_or_else(|| {
                invalid(format!(
                    "limit must be a whole number from 1 to {MAX_LIMIT}"
                ))
            })?,
    };
    Ok((optional_session_id(args)?, limit))
}

/// `prompt` is non-empty and within the size `send_session_message` allows.
pub fn parse_new(args: &Value) -> Result<(Option<String>, String), ToolError> {
    panels::validate_keys(args, &["prompt", "session_id"]).map_err(invalid)?;
    let prompt = required_string(args, "prompt")?;
    if prompt.len() > MAX_TEXT_BYTES {
        return Err(invalid(format!(
            "prompt must be at most {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok((optional_session_id(args)?, prompt))
}

/// Both ids are required: a switch always names its Session.
pub fn parse_switch(args: &Value) -> Result<(String, String), ToolError> {
    panels::validate_keys(args, &["session_id", "conversation_id"]).map_err(invalid)?;
    Ok((
        required_string(args, "session_id")?,
        required_string(args, "conversation_id")?,
    ))
}

/// The target row and its relationship; see `check_target` for what is refused.
pub fn resolve_target<'a>(
    sessions: &'a [Session],
    caller: &str,
    requested: Option<&str>,
) -> Result<(&'a Session, Relationship), ToolError> {
    let target = requested.unwrap_or(caller);
    check_target(sessions, caller, target).map_err(|refusal| refusal.tool_error(target))
}

/// One of a Session's Conversations as the host reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvRow {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub preview: String,
    pub is_current: bool,
    /// The file `switch` opens; never shown to the agent.
    pub file: String,
}

/// What the Conversation tools need from the running app.
pub(super) trait ConvHost: Clone + Send + Sync + 'static {
    fn caller_id(&self) -> &str;
    fn call_id(&self) -> &str;
    fn registry(&self) -> &SharedRegistry;
    fn is_deleting(&self, id: &str) -> bool;
    fn is_yolo(&self) -> impl Future<Output = bool> + Send;
    /// Raises the card and waits: `Ok` only when the developer approved.
    fn ask(&self, card: PendingRequest) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn is_paused(&self, id: &str) -> impl Future<Output = bool> + Send;
    /// Newest first; `limit` caps the rows when only the first few are wanted.
    fn conversations(
        &self,
        id: &str,
        limit: Option<usize>,
    ) -> impl Future<Output = Vec<ConvRow>> + Send;
    /// Holds the action for the end of the turn, or says the Session is not mid-turn.
    fn queue(
        &self,
        id: &str,
        action: HandoffAction,
        sender: Option<(String, String)>,
        asked: bool,
    ) -> impl Future<Output = Result<QueueOutcome, ToolError>> + Send;
    /// Starts a Conversation on a Stopped or idle Session and sends `first` as its first message.
    fn start_new(
        &self,
        id: &str,
        first: FirstMessage,
    ) -> impl Future<Output = Result<(), ToolError>> + Send;
    fn switch(&self, id: &str, file: String) -> impl Future<Output = Result<(), ToolError>> + Send;
    /// Tells the target's agent that its action failed after the caller stopped waiting.
    fn late_failure(&self, id: &str, reason: &str) -> impl Future<Output = ()> + Send;
}

/// The target as the call first saw it.
pub struct Gate {
    pub sessions: Vec<Session>,
    pub target: Session,
    pub relationship: Relationship,
}

async fn sessions_of(host: &impl ConvHost) -> Vec<Session> {
    host.registry().lock().await.snapshot().sessions
}

/// Resolves the target and, unless the call only reads, refuses a Session that is being deleted,
/// archived or paused. A Stopped Session passes: the action launches it.
pub(super) async fn open_gate<H: ConvHost>(
    host: &H,
    requested: Option<&str>,
    check_state: bool,
) -> Result<Gate, ToolError> {
    let sessions = sessions_of(host).await;
    let (target, relationship) = resolve_target(&sessions, host.caller_id(), requested)?;
    let target = target.clone();
    if check_state {
        if host.is_deleting(&target.id) {
            return Err(invalid_state("the target Session is being deleted"));
        }
        if target.archived_at.is_some() {
            return Err(invalid_state("the target Session is archived"));
        }
        if host.is_paused(&target.id).await {
            return Err(invalid_state("Session is paused; resume it first"));
        }
    }
    Ok(Gate {
        sessions,
        target,
        relationship,
    })
}

/// The card for one call. The id leads the title, and the relationship comes from ids, so an
/// agent-chosen name or prompt cannot pose as another Session or hide the action.
pub fn card_for(
    tool: ConvTool,
    call_id: &str,
    label: &CardLabel,
    relationship: Relationship,
    extra: &str,
) -> PendingRequest {
    let headline = format!("{} {}", label.short_id, label.name);
    let title = match tool {
        ConvTool::New => format!("Start a new Conversation in Session {headline}"),
        ConvTool::Switch => format!("Switch Conversation in Session {headline}"),
        ConvTool::List => format!("List Conversations of Session {headline}"),
    };
    let mut details = vec![relationship.label().to_string()];
    details.extend(label.context.clone());
    if !extra.is_empty() {
        details.push(approval::clip_line(extra));
    }
    if tool == ConvTool::New {
        details.extend(approval::clipped_size_line("Prompt", extra));
    }
    approval::session_card(call_id, tool.name(), title, details)
}

/// Raises the card when the relationship and mode ask for one; `true` means the developer approved.
pub(super) async fn confirm<H: ConvHost>(
    host: &H,
    tool: ConvTool,
    gate: &Gate,
    extra: &str,
) -> Result<bool, ToolError> {
    if !needs_card(gate.relationship, host.is_yolo().await) {
        return Ok(false);
    }
    let label = labels_for(
        &gate.sessions,
        std::slice::from_ref(&gate.target.id),
        &[false],
    )
    .remove(0);
    host.ask(card_for(
        tool,
        host.call_id(),
        &label,
        gate.relationship,
        extra,
    ))
    .await?;
    Ok(true)
}

/// The gate again after the card is answered, because the tree can move while the card is open.
/// A cross-Session action gets the Project's tree gate back with it, so the action runs inside the
/// gate (#1861); a self-handoff changes no tree link and takes none.
pub(super) async fn recheck<H: ConvHost>(
    host: &H,
    approved: &Gate,
    asked: bool,
) -> Result<(Gate, Option<tokio::sync::OwnedMutexGuard<()>>), ToolError> {
    let tree = match approved.target.repository_id.as_deref() {
        Some(repository_id) if approved.relationship != Relationship::Own => {
            Some(tree_gate::lock(repository_id).await)
        }
        _ => None,
    };
    let now = open_gate(host, Some(&approved.target.id), true)
        .await
        .map_err(|e| match e.code.as_str() {
            NOT_FOUND => {
                invalid_state("the target Session was removed while the approval was open")
            }
            _ => e,
        })?;
    if !asked && needs_card(now.relationship, host.is_yolo().await) {
        return Err(invalid_state(
            "the Session moved out of your own tree while the call ran; nothing was changed",
        ));
    }
    Ok((now, tree))
}

/// `(name, id)` of the caller for the message envelope; `None` when the caller acts on itself.
pub fn sender_for(gate: &Gate, caller: &str) -> Option<(String, String)> {
    let row = gate.sessions.iter().find(|s| s.id == caller)?;
    (gate.target.id != caller).then(|| (row.name.clone(), row.id.clone()))
}

fn clip_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => text[..end].to_string(),
        None => text.to_string(),
    }
}

/// Newest first, `limit` rows, previews clipped. Reads only, so no card and no state refusal.
async fn list<H: ConvHost>(host: &H, args: &Value) -> Result<Value, ToolError> {
    let (session_id, limit) = parse_list(args)?;
    let gate = open_gate(host, session_id.as_deref(), false).await?;
    let mut rows = host.conversations(&gate.target.id, Some(limit)).await;
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let conversations: Vec<Value> = rows
        .into_iter()
        .take(limit)
        .map(|c| {
            json!({
                "id": c.id,
                "title": c.title,
                "createdAt": c.created_at,
                "isCurrent": c.is_current,
                "preview": clip_chars(&c.preview, PREVIEW_CHARS),
            })
        })
        .collect();
    Ok(json!({ "session_id": gate.target.id, "conversations": conversations }))
}

/// Runs one Conversation tool for the calling Session; the router calls this for all three names.
pub async fn run(
    agent: &Arc<SessionAgent>,
    call_id: &str,
    tool: ConvTool,
    args: &Value,
) -> Result<Value, ToolError> {
    let host = AppConvHost::new(agent, call_id)?;
    run_with(&host, tool, args).await
}

pub(super) async fn run_with<H: ConvHost>(
    host: &H,
    tool: ConvTool,
    args: &Value,
) -> Result<Value, ToolError> {
    match tool {
        ConvTool::List => list(host, args).await,
        ConvTool::New => flow::new_conversation(host, args).await,
        ConvTool::Switch => flow::switch_conversation(host, args).await,
    }
}

/// The running app behind `ConvHost`.
#[derive(Clone)]
pub(super) struct AppConvHost {
    agent: Arc<SessionAgent>,
    call_id: String,
    manager: Arc<crate::session::SessionManager>,
    registry: SharedRegistry,
    state: crate::ipc::AppState,
}

impl AppConvHost {
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
}

/// The agent's hyphenated codes become the tool contract's names; a stopped agent reads as
/// `session_not_running`, as it does for `send_session_message`.
fn agent_error(code: &'static str, message: String) -> ToolError {
    match code {
        "invalid-state" => ToolError::new(INVALID_STATE, message),
        "agent-not-running" => ToolError::new(SESSION_NOT_RUNNING, message),
        other => ToolError::new(&other.replace('-', "_"), message),
    }
}

impl ConvHost for AppConvHost {
    fn caller_id(&self) -> &str {
        self.agent.tool_session_id()
    }
    fn call_id(&self) -> &str {
        &self.call_id
    }
    fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
    fn is_deleting(&self, id: &str) -> bool {
        crate::ipc::sessions_lifecycle::delete_in_flight::is_deleting(id)
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
    async fn is_paused(&self, id: &str) -> bool {
        self.manager.get_or_create_agent(id).is_paused().await
    }
    async fn conversations(&self, id: &str, limit: Option<usize>) -> Vec<ConvRow> {
        let (dir, current) = {
            let registry = self.registry.lock().await;
            match registry.get_session(id) {
                Some(s) => (s.session_dir.clone(), s.current_conversation.clone()),
                None => return Vec::new(),
            }
        };
        crate::ipc::conversations::list_conversations(dir.as_deref(), current.as_deref(), limit)
            .await
            .into_iter()
            .map(|c| ConvRow {
                id: c.id,
                title: c.title,
                created_at: c.created_at,
                preview: c.preview,
                is_current: c.is_current,
                file: c.file,
            })
            .collect()
    }
    async fn queue(
        &self,
        id: &str,
        action: HandoffAction,
        sender: Option<(String, String)>,
        asked: bool,
    ) -> Result<QueueOutcome, ToolError> {
        self.manager
            .get_or_create_agent(id)
            .queue_handoff(action, sender, asked)
            .await
            .map_err(|e| agent_error(e.code, e.message))
    }
    async fn start_new(&self, id: &str, first: FirstMessage) -> Result<(), ToolError> {
        self.manager
            .get_or_create_agent(id)
            .start_conversation_then_send(first)
            .await
            .map_err(|failed| agent_error(failed.error.code, failed.error.message))
    }
    async fn switch(&self, id: &str, file: String) -> Result<(), ToolError> {
        crate::ipc::conversations_core::switch_core(&self.state, id, &file)
            .await
            .map_err(ipc_error)?;
        self.agent
            .tool_events()
            .emit_session_conversation_changed(id);
        Ok(())
    }
    async fn late_failure(&self, id: &str, reason: &str) {
        self.manager
            .get_or_create_agent(id)
            .report_late_handoff_failure(reason)
            .await;
    }
}

#[path = "sessions_conversations_dispatch.rs"]
mod detached;
use detached::dispatch;
pub use detached::Dispatch;

#[path = "sessions_conversations_flow.rs"]
mod flow;

#[cfg(test)]
#[path = "sessions_conversations.test.rs"]
mod tests;
