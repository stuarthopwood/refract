// The six Session end tools on `EndHost`. Order of checks: arguments, target refusal, state, card,
// then a re-check under the Project's tree gate before anything is changed, because the tree can
// move while the card is open.

use std::sync::Arc;

use serde_json::{json, Value};

use super::router::{ToolError, CANCELLED};
use super::sessions::NOT_FOUND;
use super::sessions_end::{
    card_for, labels_for, needs_card, parse_args, refuse_target, AppEndHost, EndHost, EndTool,
    CHILD_LIMIT, INVALID_STATE,
};
use super::sessions_send::SESSION_NOT_RUNNING;
use super::tree_gate;
use crate::session::agent::SessionAgent;
use crate::store::registry::Session;
use crate::store::session_tree::{descendants, live_children, MAX_LIVE_CHILDREN};

/// What a call acts on: the target first, then any cascaded descendants, and whether each sits in
/// the caller's own tree, which the approved card stated. A rename while the card is open
/// changes none of these, so it does not cancel the call.
#[derive(PartialEq, Eq)]
struct Plan {
    ids: Vec<String>,
    inside: Vec<bool>,
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

fn partial_cascade(error: ToolError, archived: &[String]) -> ToolError {
    if archived.is_empty() {
        return error;
    }
    ToolError::new(
        &error.code,
        format!(
            "{}; already archived: {}",
            error.message,
            archived.join(", ")
        ),
    )
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
            let full = target
                .parent_session_id
                .as_deref()
                .is_some_and(|parent| live_children(sessions, parent).count() >= MAX_LIVE_CHILDREN);
            if full {
                // Same code restore_core gives, raised before the card so nobody approves a doomed call.
                return Err(ToolError::new(
                    CHILD_LIMIT,
                    format!("the parent has {MAX_LIVE_CHILDREN} live children"),
                ));
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
    let inside = ids
        .iter()
        .map(|id| tree_gate::inside_own_tree(sessions, host.caller_id(), id, None))
        .collect();
    Ok(Plan {
        ids,
        inside,
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
        let labels = labels_for(&sessions, host.caller_id(), &plan.ids);
        host.ask(card_for(tool, host.call_id(), &labels, plan.reroots))
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

const STOPPED_NOTE: &str = "the agents had already been stopped";

/// The checks that must hold again once the card is answered and the gate is held. `Err` means
/// nothing was changed by this call, unless `stopped`: the cascade's agents are already down.
async fn recheck<H: EndHost>(
    host: &H,
    tool: EndTool,
    id: &str,
    include_children: bool,
    approved: &Plan,
    asked: bool,
    stopped: bool,
) -> Result<(), ToolError> {
    let outcome = recheck_plan(host, tool, id, include_children, approved, asked).await;
    outcome.map_err(|e| {
        if !stopped {
            e
        } else if e.message.ends_with("; nothing was changed, call again") {
            let what = e
                .message
                .trim_end_matches("; nothing was changed, call again");
            ToolError::new(&e.code, format!("{what}; {STOPPED_NOTE}, call again"))
        } else {
            ToolError::new(&e.code, format!("{} ({STOPPED_NOTE})", e.message))
        }
    })
}

async fn recheck_plan<H: EndHost>(
    host: &H,
    tool: EndTool,
    id: &str,
    include_children: bool,
    approved: &Plan,
    asked: bool,
) -> Result<(), ToolError> {
    let sessions = sessions_of(host).await;
    let target =
        refuse_target(&sessions, host.caller_id(), id).map_err(|e| match e.code.as_str() {
            NOT_FOUND => changed("the target Session was removed"),
            _ => e,
        })?;
    let now = plan_for(host, tool, &sessions, target, include_children).await?;
    if now != *approved {
        return Err(changed("the Sessions this call acts on changed"));
    }
    // No card was shown because the target was in the own tree; if it no longer is, the
    // developer never saw this change, so it is refused rather than applied.
    let inside = inside_own_tree(host, &sessions, id);
    if !asked && needs_card(tool, inside, host.is_yolo().await) {
        return Err(changed("the Session moved out of your own tree"));
    }
    Ok(())
}

/// Stops every running member's agent at once, so the cascade waits for the slowest shutdown
/// instead of the sum of them.
async fn shut_down_running<H: EndHost>(host: &Arc<H>, ids: &[String]) {
    let mut shutdowns = tokio::task::JoinSet::new();
    for id in ids {
        if host.is_running(id).await {
            let (host, id) = (host.clone(), id.clone());
            shutdowns.spawn(async move { host.shutdown(&id).await });
        }
    }
    while let Some(joined) = shutdowns.join_next().await {
        if let Err(error) = joined {
            log::warn!("a Session shutdown task ended abnormally: {error}");
        }
    }
}

/// The archive cascade. Agents stop outside the tree gate, which blocks every tree change in
/// the Project; only the registry patches, deepest first, run under it.
async fn archive_members<H: EndHost>(
    host: &Arc<H>,
    tool: EndTool,
    id: &str,
    include_children: bool,
    repository_id: &str,
    approved: &Plan,
    asked: bool,
) -> Result<Value, ToolError> {
    shut_down_running(host, &approved.ids).await;
    let _gate = tree_gate::lock(repository_id).await;
    // The tree can move while the agents stop, so the plan is checked again before any patch.
    recheck(&**host, tool, id, include_children, approved, asked, true).await?;
    let mut archived = Vec::new();
    // Deepest first, so a parent is never archived above a live child mid-way.
    for member in approved.ids.iter().rev() {
        host.archive(member)
            .await
            .map_err(|e| partial_cascade(e, &archived))?;
        archived.push(member.clone());
    }
    Ok(json!({ "outcome": "archived", "ids": approved.ids }))
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
    recheck(&*host, tool, &id, include_children, &approved, asked, false).await?;
    if tool == EndTool::Archive {
        // Released: stopping agents is slow, and the cascade takes the gate back for the patches.
        drop(gate);
        return archive_members(
            &host,
            tool,
            &id,
            include_children,
            &repository_id,
            &approved,
            asked,
        )
        .await;
    }
    // Released before the action: restore takes the gate itself, and the others run long and
    // change no tree links.
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

#[cfg(test)]
#[path = "sessions_end_cascade.test.rs"]
mod cascade_tests;
