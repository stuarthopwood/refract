// Per-Session working mode (#433): Interactive, Plan, Grill, Away. Approval mode stays app-wide.
// Plan needs an OMP restart (rpc-ui has no plan toggle), so a change mid-turn waits for the settle.

pub mod away;
mod store;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::omp::transcript::file_attachment_markers::HIDDEN_INSTRUCTION_OPEN;
use crate::session::agent::{AgentError, SessionAgent, SessionStatus};

const GRILL_INSTRUCTION: &str = "Grill mode is on. Interview me about this request before acting: ask one question at a time, give your recommended answer with each question, and check it against CONTEXT.md and docs/adr in this repository. Do not edit files or run commands that change anything until I tell you to proceed.";

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
    away_epoch: u64,
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
    let values = crate::omp::token_guard::values::load(&crate::data_dir()).await;
    if values.get("plan.defaultOnStartup").and_then(Value::as_bool) == Some(true) {
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

async fn away_epoch(agent: &SessionAgent) -> u64 {
    agent.with_working_mode_state(|s| s.away_epoch).await
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

/// Appends the hidden Grill instruction; the transcript cuts it back off.
pub(in crate::session) async fn decorate_prompt(agent: &SessionAgent, text: String) -> String {
    ensure_loaded(agent).await;
    let grill = agent.with_working_mode_state(|s| s.mode).await == WorkingMode::Grill;
    if grill && !text.trim_start().starts_with('/') {
        // A user-typed marker would hide the rest of their own message in the transcript.
        let text = text.replace(HIDDEN_INSTRUCTION_OPEN, "\n\n");
        format!("{text}{HIDDEN_INSTRUCTION_OPEN}{GRILL_INSTRUCTION}")
    } else {
        text
    }
}

/// `workingMode.set`: applies the mode, or queues a plan switch until the turn ends.
pub async fn set_mode(agent: &SessionAgent, raw: &str) -> Result<Value, AgentError> {
    let target = WorkingMode::parse(raw).ok_or_else(|| {
        AgentError::new("invalid-argument", format!("unknown working mode: {raw}"))
    })?;
    ensure_loaded(agent).await;
    let (previous, applied) = agent
        .with_working_mode_and_status(|s, status, has_process| {
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
            if target == WorkingMode::Away {
                s.away_epoch += 1;
            }
            (
                previous,
                if needs_restart {
                    Applied::Restart
                } else {
                    Applied::Switched
                },
            )
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

/// Spawned: stopping OMP waits on its exit, which the frame listener that may be calling us would block.
fn restart(agent: &SessionAgent) {
    let agent = agent.arc();
    tokio::spawn(async move {
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
        if crate::ipc::sessions_lifecycle::delete_in_flight::refuse_if_deleting(agent.session_id())
            .is_err()
        {
            return;
        }
        if let Err(err) = agent.start().await {
            log::warn!("working_mode: restart after plan switch failed: {err}");
        }
    });
}

/// Applies a waiting plan switch once the turn has settled.
pub(in crate::session) async fn on_turn_settled(agent: &SessionAgent) {
    let applied = agent
        .with_working_mode_state(|s| {
            let target = s.pending.take()?;
            s.mode = target;
            if target == WorkingMode::Away {
                s.away_epoch += 1;
            }
            Some((target, (target == WorkingMode::Plan) != s.launched_plan))
        })
        .await;
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
