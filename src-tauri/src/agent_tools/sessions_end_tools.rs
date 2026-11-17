// The six Session end tools on `EndHost`. Order of checks: arguments, target refusal, state, card,
// then a re-check under the Project's tree gate before anything is changed, because the tree can
// move while the card is open.

use std::sync::Arc;

use serde_json::{json, Value};

use super::router::{ToolError, CANCELLED};
use super::sessions::NOT_FOUND;
use super::sessions_end::{
    card_for, needs_card, parse_args, refuse_target, AppEndHost, EndHost, EndTool, CHILD_LIMIT,
    INVALID_STATE,
};
use super::sessions_send::SESSION_NOT_RUNNING;
use super::tree_gate;
use crate::session::agent::SessionAgent;
use crate::store::registry::Session;
use crate::store::session_tree::{descendants, live_children, MAX_LIVE_CHILDREN};

/// What a call acts on: the target first, then any cascaded descendants.
#[derive(PartialEq, Eq)]
struct Plan {
    ids: Vec<String>,
    names: Vec<String>,
    reroots: bool,
}

/// Runs one end tool for the calling Session; the router calls this for all six names.
pub async fn run(
    agent: &Arc<SessionAgent>,
    call_id: &str,
    tool: EndTool,
    args: &Value,
) -> Result<Value, ToolError> {
    let host = Arc::new(AppEndHost::new(agent, call_id)?);
    run_with(&host, tool, args).await
}

async fn sessions_of(host: &impl EndHost) -> Vec<Session> {
    host.registry().lock().await.snapshot().sessions
}

fn invalid_state(message: impl Into<String>) -> ToolError {
    ToolError::new(INVALID_STATE, message)
}

fn not_running() -> ToolError {
    ToolError::new(SESSION_NOT_RUNNING, "the target Session is stopped")
}

fn name_of(sessions: &[Session], id: &str) -> String {
    sessions
        .iter()
        .find(|s| s.id == id)
        .map_or_else(|| id.to_string(), |s| s.name.clone())
}

/// The state refusals and the set of Sessions the call acts on.
async fn plan_for<H: EndHost>(
    host: &H,
    tool: EndTool,
    sessions: &[Session],
    target: &Session,
    include_children: bool,
) -> Result<Plan, ToolError> {
    if host.is_deleting(&target.id) {
        return Err(invalid_state("the target Session is being deleted"));
    }
    let mut ids = vec![target.id.clone()];
    let mut reroots = false;
    match tool {
        EndTool::Archive => {
            if target.archived_at.is_some() {
                return Err(invalid_state("the target Session is already archived"));
            }
            if include_children {
                for id in descendants(sessions, &target.id) {
                    if host.is_deleting(&id) {
                        return Err(invalid_state(format!(
                            "Session {id} below the target is being deleted"
                        )));
                    }
                    let archived = sessions
                        .iter()
                        .any(|s| s.id == id && s.archived_at.is_some());
                    if !archived {
                        ids.push(id);
                    }
                }
            }
        }
        EndTool::Unarchive => {
            if target.archived_at.is_none() {
                return Err(invalid_state("the target Session is not archived"));
            }
            let full = target.parent_session_id.as_deref().is_some_and(|parent| {
                live_children(sessions, parent).count() >= MAX_LIVE_CHILDREN
            });
            if full {
                // Same code restore_core gives, raised before the card so nobody approves a doomed call.
                return Err(ToolError::new(CHILD_LIMIT, "the parent has 4 live children"));
            }
        }
        EndTool::Stop => {
            if !host.is_running(&target.id).await {
                return Err(not_running());
            }
        }
        EndTool::Pause | EndTool::Resume => {
            if !host.is_running(&target.id).await {
                return Err(not_running());
            }
            let paused = host.is_paused(&target.id).await;
            if tool == EndTool::Pause && paused {
                return Err(invalid_state("the target Session is already paused"));
            }
            if tool == EndTool::Resume && !paused {
                return Err(invalid_state("the target Session is not paused"));
            }
        }
        EndTool::Delete => reroots = live_children(sessions, &target.id).next().is_some(),
    }
    let names = ids.iter().map(|id| name_of(sessions, id)).collect();
    Ok(Plan {
        ids,
        names,
        reroots,
    })
}

fn inside_own_tree(host: &impl EndHost, sessions: &[Session], target: &str) -> bool {
    tree_gate::inside_own_tree(sessions, host.caller_id(), target, None)
}

async fn run_with<H: EndHost>(
    host: &Arc<H>,
    tool: EndTool,
    args: &Value,
) -> Result<Value, ToolError> {
    let parsed = parse_args(tool, args)?;
    let sessions = sessions_of(&**host).await;
    let target = refuse_target(&sessions, host.caller_id(), &parsed.id)?;
    let repository_id = target
        .repository_id
        .clone()
        .ok_or_else(|| ToolError::new(NOT_FOUND, format!("no Session has id {}", parsed.id)))?;
    let plan = plan_for(&**host, tool, &sessions, target, parsed.include_children).await?;
    if tool == EndTool::Delete {
        // Before the card, so a refusal never asks the developer about something that cannot run.
        host.delete_precheck(&parsed.id).await?;
    }
    let inside = inside_own_tree(&**host, &sessions, &parsed.id);
    let asked = needs_card(tool, inside, host.is_yolo().await);
    if asked {
        host.ask(card_for(tool, host.call_id(), &plan.names, plan.reroots))
            .await?;
    }
    // Spawned and awaited: a cancelled call drops only this wait, so a cascade is never left
    // half done by the caller going away.
    let task = commit(
        host.clone(),
        tool,
        parsed.id,
        parsed.include_children,
        repository_id,
        plan,
        asked,
    );
    tokio::spawn(task)
        .await
        .unwrap_or_else(|e| Err(ToolError::new(CANCELLED, format!("end task ended: {e}"))))
}

fn changed(what: &str) -> ToolError {
    ToolError::new(
        CANCELLED,
        format!("{what} while the approval was open; nothing was changed, call again"),
    )
}

/// The actions after approval, behind the Project's tree gate.
async fn commit<H: EndHost>(
    host: Arc<H>,
    tool: EndTool,
    id: String,
    include_children: bool,
    repository_id: String,
    approved: Plan,
    asked: bool,
) -> Result<Value, ToolError> {
    let gate = tree_gate::lock(&repository_id).await;
    let sessions = sessions_of(&*host).await;
    let target =
        refuse_target(&sessions, host.caller_id(), &id).map_err(|e| match e.code.as_str() {
            NOT_FOUND => changed("the target Session was removed"),
            _ => e,
        })?;
    let now = plan_for(&*host, tool, &sessions, target, include_children).await?;
    if now != approved {
        return Err(changed("the Sessions this call acts on changed"));
    }
    // No card was shown because the target was in the own tree; if it no longer is, the
    // developer never saw this change, so it is refused rather than applied.
    let inside = inside_own_tree(&*host, &sessions, &id);
    if !asked && needs_card(tool, inside, host.is_yolo().await) {
        return Err(changed("the Session moved out of your own tree"));
    }
    if tool == EndTool::Archive {
        // Deepest first, so a parent is never archived above a live child mid-way.
        for member in approved.ids.iter().rev() {
            host.archive(member).await?;
        }
        return Ok(json!({ "outcome": "archived", "ids": approved.ids }));
    }
    // The IPC cores for these take the gate themselves or run long; the re-check above is done.
    drop(gate);
    let outcome = match tool {
        EndTool::Unarchive => host.restore(&id).await.map(|()| "unarchived"),
        EndTool::Stop => host.stop(&id).await.map(|()| "stopped"),
        EndTool::Pause => host.pause(&id).await.map(|()| "paused"),
        EndTool::Resume => host.resume(&id).await.map(|()| "resumed"),
        EndTool::Delete => host.delete(&id).await.map(|()| "deleting"),
        EndTool::Archive => unreachable!("archive returned above"),
    }?;
    Ok(json!({ "outcome": outcome, "id": id }))
}

#[cfg(test)]
#[path = "sessions_end_tools.test.rs"]
mod tests;
