// Per-Session working mode (#433): Interactive, Plan, Grill, Away. Approval mode stays app-wide.
// Plan needs an OMP restart (rpc-ui has no plan toggle), so a change mid-turn waits for the settle.

pub mod away;
mod away_form;
mod store;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::omp::transcript::file_attachment_markers::HIDDEN_INSTRUCTION_OPEN;
use crate::session::agent::{AgentError, SessionAgent, SessionStatus};

const PLAN_INSTRUCTION: &str = "Plan mode is on. Plan only: do not create, edit, rename or delete any file, and do not run commands that change anything. File writes are refused in this mode. Write the plan in your reply.";
const GRILL_INSTRUCTION: &str = "Grill mode is on. Interview me about this request before acting: ask one question at a time, give your recommended answer with each question, and check it against CONTEXT.md and docs/adr in this repository. Do not edit files or run commands that change anything until I tell you to proceed.";
const AWAY_INSTRUCTION: &str = "Away mode is on: you are unattended and I will not answer. Do not use the ask tool. Act on your best recommendation, or consult a subagent or do research. Stop only for a genuinely dangerous or irreversible operation. Put \"you are unattended, do not ask\" in every subagent brief you write.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkingMode {
    #[default]
    Interactive,
    Plan,
    Grill,
    Away,
}

impl WorkingMode {
    pub fn persistable(self) -> Self {
        if self == Self::Away {
            Self::Interactive
        } else {
            self
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "interactive" => Some(Self::Interactive),
            "plan" => Some(Self::Plan),
            "grill" => Some(Self::Grill),
            "away" => Some(Self::Away),
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct State {
    loaded: bool,
    mode: WorkingMode,
    launched_plan: bool,
    pending: Option<WorkingMode>,
    /// A plan restart is shutting the process down or waiting to relaunch it. A second request in
    /// that window would shut down the relaunched process, so it is dropped: the restart in flight
    /// reads the latest mode when it starts, and `on_launched` catches a change that lands later.
    restarting: bool,
    away: away::Log,
}

impl State {
    pub(in crate::session) fn insert_wire(&self, obj: &mut Map<String, Value>) {
        obj.insert("workingMode".to_string(), json!(self.mode));
        if let Some(pending) = self.pending {
            obj.insert("workingModePending".to_string(), json!(pending));
        }
    }
}

enum Applied {
    Same,
    Switched,
    Pending,
    Restart,
}

async fn default_mode() -> WorkingMode {
    use crate::omp::token_guard::{legacy, migrate};
    let dir = crate::data_dir();
    let on = if migrate::is_done(&dir).await {
        crate::omp::config::get_config("plan.defaultOnStartup", &[])
            .await
            .ok()
            .and_then(|entry| entry.get("value").and_then(Value::as_bool))
            == Some(true)
    } else {
        legacy::effective(&dir)
            .await
            .get("plan.defaultOnStartup")
            .and_then(Value::as_bool)
            == Some(true)
    };
    if on {
        WorkingMode::Plan
    } else {
        WorkingMode::Interactive
    }
}

/// Loads the stored mode once per agent; a Session with none starts Interactive, or Plan when #695's setting is on.
pub(in crate::session) async fn ensure_loaded(agent: &SessionAgent) {
    if agent.with_working_mode_state(|s| s.loaded).await {
        return;
    }
    let stored = store::load(agent.session_id()).await;
    let mode = match stored {
        Some(mode) => mode.persistable(),
        None => default_mode().await,
    };
    agent
        .with_working_mode_state(|s| {
            if !s.loaded {
                s.loaded = true;
                s.mode = mode;
            }
        })
        .await;
}

pub(in crate::session) async fn is_away(agent: &SessionAgent) -> bool {
    agent
        .with_working_mode_state(|s| s.mode == WorkingMode::Away)
        .await
}

/// Whether the next OMP launch starts in plan mode; recorded so a later switch knows if it needs a restart.
pub(in crate::session) async fn plan_for_launch(agent: &SessionAgent) -> bool {
    ensure_loaded(agent).await;
    agent
        .with_working_mode_state(|s| {
            s.launched_plan = s.mode == WorkingMode::Plan;
            s.launched_plan
        })
        .await
}

/// Whether the process now running was launched in plan mode.
pub(in crate::session) async fn launched_plan(agent: &SessionAgent) -> bool {
    agent.with_working_mode_state(|s| s.launched_plan).await
}

/// Marks a fixture agent as launched in plan mode or not, without the persistence `set_mode` does.
#[cfg(test)]
pub(in crate::session) async fn set_launched_plan_for_test(agent: &SessionAgent, plan: bool) {
    agent
        .with_working_mode_state(|s| {
            s.loaded = true;
            s.launched_plan = plan;
            s.mode = if plan {
                WorkingMode::Plan
            } else {
                WorkingMode::Interactive
            };
        })
        .await;
}

fn instruction_for(mode: WorkingMode) -> Option<&'static str> {
    match mode {
        WorkingMode::Plan => Some(PLAN_INSTRUCTION),
        WorkingMode::Grill => Some(GRILL_INSTRUCTION),
        WorkingMode::Away => Some(AWAY_INSTRUCTION),
        WorkingMode::Interactive => None,
    }
}

/// Appends the hidden Plan, Grill or Away instruction; the transcript cuts it back off.
pub(in crate::session) async fn decorate_prompt(agent: &SessionAgent, text: String) -> String {
    ensure_loaded(agent).await;
    let mode = agent.with_working_mode_state(|s| s.mode).await;
    let Some(instruction) = instruction_for(mode) else {
        return text;
    };
    if text.trim_start().starts_with('/') {
        return text;
    }
    // A user-typed marker would hide the rest of their own message in the transcript.
    let text = text.replace(HIDDEN_INSTRUCTION_OPEN, "\n\n");
    format!("{text}{HIDDEN_INSTRUCTION_OPEN}{instruction}")
}

fn launch_is_stale(s: &State) -> bool {
    (s.mode == WorkingMode::Plan) != s.launched_plan
}

/// A plan switch made while OMP was starting saw no process, so it asked for no restart; once the new
/// process is up, relaunch it if it started in the other mode. Returns whether a restart was requested.
pub(in crate::session) async fn on_launched(agent: &SessionAgent) -> bool {
    relaunch_if_stale(agent, restart).await
}

/// `restart` is the seam that lets a test observe the request without relaunching a process.
async fn relaunch_if_stale(agent: &SessionAgent, restart: impl FnOnce(&SessionAgent)) -> bool {
    let stale = agent.with_working_mode_state(|s| launch_is_stale(s)).await;
    if stale {
        log::info!(
            "working_mode: relaunching {} for a mode change made during start",
            agent.session_id()
        );
        restart(agent);
    }
    stale
}

/// Records `target` in `s` and says what the switch needs. A restart is only for a process that is already
/// recorded: one still starting reads the mode when it launches, or is caught by `on_launched` if it did not.
fn decide(
    s: &mut State,
    target: WorkingMode,
    status: SessionStatus,
    has_process: bool,
) -> (WorkingMode, Applied) {
    let previous = s.mode;
    s.pending = None;
    if previous == target {
        return (previous, Applied::Same);
    }
    // Leaving Away takes effect at once, even when the plan switch must wait.
    let current = if previous == WorkingMode::Away {
        WorkingMode::Interactive
    } else {
        previous
    };
    let needs_restart = has_process && (target == WorkingMode::Plan) != s.launched_plan;
    if needs_restart && matches!(status, SessionStatus::Working | SessionStatus::NeedsYou) {
        s.mode = current;
        s.pending = Some(target);
        return (previous, Applied::Pending);
    }
    s.mode = target;
    let applied = if needs_restart {
        Applied::Restart
    } else {
        Applied::Switched
    };
    (previous, applied)
}

/// `workingMode.set`: applies the mode, or queues a plan switch until the turn ends.
pub async fn set_mode(agent: &SessionAgent, raw: &str) -> Result<Value, AgentError> {
    let target = WorkingMode::parse(raw).ok_or_else(|| {
        AgentError::new("invalid-argument", format!("unknown working mode: {raw}"))
    })?;
    ensure_loaded(agent).await;
    let (previous, applied) = agent
        .with_working_mode_and_status(|s, status, has_process| {
            decide(s, target, status, has_process)
        })
        .await;
    if matches!(applied, Applied::Same) {
        // Re-picking the current mode cancels a waiting switch, so the hint must clear.
        agent.emit_status().await;
        return Ok(json!({ "mode": target }));
    }
    if previous == WorkingMode::Away {
        away::summarise(agent).await;
    }
    if !matches!(applied, Applied::Pending) {
        store::save(agent.session_id(), target).await;
    }
    agent.emit_status().await;
    if matches!(applied, Applied::Restart) {
        restart(agent);
    }
    if target == WorkingMode::Away {
        away::sweep(agent).await;
    }
    Ok(json!({ "mode": target, "pending": matches!(applied, Applied::Pending) }))
}

/// Takes the single restart slot; `false` when a restart is already in flight.
fn claim_restart(s: &mut State) -> bool {
    !std::mem::replace(&mut s.restarting, true)
}

/// Owns the restart slot. A panic or an aborted task would otherwise leave it taken for good, and
/// every later plan switch would be dropped as "already in flight".
struct RestartSlot {
    agent: Option<Arc<SessionAgent>>,
}

impl RestartSlot {
    async fn claim(agent: &Arc<SessionAgent>) -> Option<Self> {
        agent
            .with_working_mode_state(claim_restart)
            .await
            .then(|| Self {
                agent: Some(Arc::clone(agent)),
            })
    }

    /// The normal release: awaited, so the slot is free before the caller goes on.
    async fn release(mut self) {
        if let Some(agent) = self.agent.take() {
            agent
                .with_working_mode_state(|s| s.restarting = false)
                .await;
        }
    }
}

impl Drop for RestartSlot {
    /// The state lock is async, so the release runs on the runtime; with none left there is nothing to free.
    fn drop(&mut self) {
        let Some(agent) = self.agent.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                agent
                    .with_working_mode_state(|s| s.restarting = false)
                    .await;
            });
        }
    }
}

/// Spawned: stopping OMP waits on its exit, which the frame listener that may be calling us would block.
fn restart(agent: &SessionAgent) {
    let agent = agent.arc();
    tokio::spawn(async move {
        let Some(slot) = RestartSlot::claim(&agent).await else {
            log::info!(
                "working_mode: restart for {} already in flight",
                agent.session_id()
            );
            return;
        };
        agent.shutdown().await;
        // start() is a no-op while the old process is still recorded; its exit handler clears it asynchronously.
        for _ in 0..100 {
            if !agent.has_process().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // A delete may have claimed the Session during the waits above; starting now would race the worktree removal.
        let deleting = crate::ipc::sessions_lifecycle::delete_in_flight::refuse_if_deleting(
            agent.session_id(),
        )
        .is_err();
        // Released before start(): the new process runs `on_launched`, which may need a restart of its own.
        slot.release().await;
        if deleting {
            return;
        }
        if let Err(err) = agent.start().await {
            log::warn!("working_mode: restart after plan switch failed: {err}");
        }
    });
}

/// Applies a waiting switch to `s`: the target and whether it needs a restart, or `None` when nothing waits.
fn settle_pending(s: &mut State) -> Option<(WorkingMode, bool)> {
    let target = s.pending.take()?;
    s.mode = target;
    Some((target, (target == WorkingMode::Plan) != s.launched_plan))
}

/// Applies a waiting plan switch once the turn has settled.
pub(in crate::session) async fn on_turn_settled(agent: &SessionAgent) {
    let applied = agent.with_working_mode_state(settle_pending).await;
    let Some((target, needs_restart)) = applied else {
        return;
    };
    store::save(agent.session_id(), target).await;
    agent.emit_status().await;
    if needs_restart {
        restart(agent);
    }
    if target == WorkingMode::Away {
        away::sweep(agent).await;
    }
}

/// An unexpected exit drops Away back to Interactive, as a restart would.
pub(in crate::session) async fn on_exit(agent: &SessionAgent, requested: bool) {
    if requested {
        return;
    }
    let was_away = agent
        .with_working_mode_state(|s| {
            let away = s.mode == WorkingMode::Away;
            if away {
                s.mode = WorkingMode::Interactive;
            }
            away
        })
        .await;
    if was_away {
        away::summarise(agent).await;
        agent.emit_status().await;
    }
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
