// Plan mode owns the Session's model role (#1946): under rpc-ui omp never picks `modelRoles.plan`
// itself (only its TUI does), so Refract queues a switch to the Plan role when a plan launch starts
// and queues the previous role or pinned model back once a non-plan launch follows.

use std::future::Future;

use crate::session::pending_selection::Target;

use super::super::agent::SessionAgent;
use super::model_support;

pub(in crate::session) const PLAN_ROLE: &str = "plan";
/// Where a Session that was already on the Plan role goes on leaving plan mode.
const FALLBACK_ROLE: &str = "default";

/// What plan mode displaced, held for the whole plan stint (it survives the plan-mode restart).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::session) struct Swap {
    restore: Target,
}

/// The Session's selection as the launch sees it.
pub(super) struct Selection<'a> {
    pub(super) pinned: bool,
    pub(super) role: Option<&'a str>,
    /// `(provider, id)` of the registry's last model, the one a pin names.
    pub(super) last_model: Option<(&'a str, &'a str)>,
    /// A role or model the user queued while the Session was stopped, not yet applied. Plan's own
    /// queued switch is not counted: it is what a launch queues, never what the user chose.
    pub(super) queued: Option<&'a Target>,
}

impl Selection<'_> {
    fn user_queued(&self) -> Option<&Target> {
        self.queued
            .filter(|target| **target != Target::Role(PLAN_ROLE.to_string()))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Keep,
    /// First plan launch: remember `restore`, and queue the Plan role when `apply`.
    Enter {
        swap: Swap,
        apply: bool,
    },
    /// First non-plan launch after a plan stint: queue `restore` back.
    Leave {
        restore: Target,
    },
    /// The stint ended but the user chose another role or model meanwhile; leave that choice alone.
    Forget,
}

/// A role that names nothing to go back to: omp's ad-hoc `/switch @<role>` marker, the retry
/// fallback marker, a blank value, or the Plan role itself.
fn names_no_role(role: &str) -> bool {
    role.is_empty()
        || role == PLAN_ROLE
        || role == model_support::AD_HOC_ROLE
        || role == model_support::FALLBACK_MARKER_ROLE
}

/// What to bring back on leaving plan mode: the user's queued pick, else the pinned model, else the
/// role the Session was on. When none of those is known (a restart lost the carried role, or a pin
/// has no recorded model) it is `default`, so the Session never stays on Plan.
fn displaced(selection: &Selection<'_>) -> Target {
    if let Some(queued) = selection.user_queued() {
        return queued.clone();
    }
    if selection.pinned {
        if let Some((provider, id)) = selection.last_model {
            return Target::Model {
                provider: provider.to_string(),
                model_id: id.to_string(),
            };
        }
    } else if let Some(role) = selection.role.filter(|role| !names_no_role(role)) {
        return Target::Role(role.to_string());
    }
    Target::Role(FALLBACK_ROLE.to_string())
}

/// `plan_configured` is whether `modelRoles.plan` resolves; without it the switch could never apply.
pub(super) fn step(
    launched_plan: bool,
    swap: Option<&Swap>,
    selection: &Selection<'_>,
    plan_configured: bool,
) -> Step {
    match (launched_plan, swap) {
        (true, None) if plan_configured => Step::Enter {
            swap: Swap {
                restore: displaced(selection),
            },
            // A queued pick would otherwise be applied over the Plan role, so Plan goes in its place.
            apply: selection.pinned
                || selection.role != Some(PLAN_ROLE)
                || selection.user_queued().is_some(),
        },
        // The user picked something while stopped: their queued choice wins over the restore.
        (false, Some(_)) if selection.user_queued().is_some() => Step::Forget,
        (false, Some(swap)) if !selection.pinned && selection.role == Some(PLAN_ROLE) => {
            Step::Leave {
                restore: swap.restore.clone(),
            }
        }
        (false, Some(_)) => Step::Forget,
        _ => Step::Keep,
    }
}

async fn last_model(agent: &SessionAgent) -> Option<(String, String)> {
    let registry = agent.registry().lock().await;
    let model = registry
        .get_session(agent.session_id())?
        .last_model
        .as_ref()?;
    Some((model.provider.clone(), model.id.clone()))
}

/// Whether omp's role map resolves `modelRoles.plan`.
async fn plan_role_configured() -> bool {
    match crate::ipc::model_roles::get_model_roles_reliable().await {
        Ok(map) => model_support::resolve_role_selector(&map, PLAN_ROLE).is_some(),
        Err(err) => {
            log::warn!("plan_role: could not read the model roles: {err}");
            false
        }
    }
}

/// Runs at every launch, after the role is seeded; the launch's closing drain applies what it queues.
pub(super) async fn on_launch(agent: &SessionAgent) {
    on_launch_with(agent, plan_role_configured).await;
}

/// `plan_configured` is the seam that lets a test drive the launch without spawning omp.
async fn on_launch_with<F, Fut>(agent: &SessionAgent, plan_configured: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    let launched_plan = crate::session::working_mode::launched_plan(agent).await;
    let swap = agent.with_model_state(|s| s.plan_swap.clone()).await;
    if launched_plan == swap.is_some() {
        return;
    }
    let (pinned, role) = model_support::resolve_current_selection(agent).await;
    let last = last_model(agent).await;
    let queued = crate::session::pending_selection::queued_target(agent).await;
    let selection = Selection {
        pinned,
        role: role.as_deref(),
        last_model: last.as_ref().map(|(p, i)| (p.as_str(), i.as_str())),
        queued: queued.as_ref(),
    };
    // Only an entering launch needs omp's role map, so a restart inside a plan stint skips the read.
    let plan_configured = launched_plan && plan_configured().await;
    match step(launched_plan, swap.as_ref(), &selection, plan_configured) {
        Step::Keep => {}
        Step::Enter { swap, apply } => {
            agent.with_model_state(|s| s.plan_swap = Some(swap)).await;
            if apply {
                crate::session::pending_selection::queue(
                    agent,
                    Target::Role(PLAN_ROLE.to_string()),
                )
                .await;
            }
        }
        Step::Leave { restore } => {
            agent.with_model_state(|s| s.plan_swap = None).await;
            crate::session::pending_selection::queue(agent, restore).await;
        }
        Step::Forget => agent.with_model_state(|s| s.plan_swap = None).await,
    }
}

#[cfg(test)]
#[path = "plan_role.test.rs"]
mod tests;
