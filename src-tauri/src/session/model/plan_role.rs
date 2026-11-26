// Plan mode owns the Session's model role (#1946): under rpc-ui omp never picks `modelRoles.plan`
// itself (only its TUI does), so Refract queues a switch to the Plan role when a plan launch starts
// and queues the previous role or pinned model back once a non-plan launch follows.

use crate::session::pending_selection::Target;

use super::super::agent::SessionAgent;
use super::model_support;

pub(in crate::session) const PLAN_ROLE: &str = "plan";
/// Where a Session that was already on the Plan role goes on leaving plan mode.
const FALLBACK_ROLE: &str = "default";

/// What plan mode displaced, held for the whole plan stint (it survives the plan-mode restart).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::session) struct Swap {
    restore: Option<Target>,
}

/// The Session's selection as the launch sees it.
pub(super) struct Selection<'a> {
    pub(super) pinned: bool,
    pub(super) role: Option<&'a str>,
    /// `(provider, id)` of the registry's last model, the one a pin names.
    pub(super) last_model: Option<(&'a str, &'a str)>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Keep,
    /// First plan launch: remember `restore`, and queue the Plan role when `apply`.
    Enter { swap: Swap, apply: bool },
    /// First non-plan launch after a plan stint: queue `restore` back, if any.
    Leave { restore: Option<Target> },
    /// The stint ended but the user chose another role or model meanwhile; leave that choice alone.
    Forget,
}

fn displaced(selection: &Selection<'_>) -> Option<Target> {
    if selection.pinned {
        let (provider, id) = selection.last_model?;
        return Some(Target::Model {
            provider: provider.to_string(),
            model_id: id.to_string(),
        });
    }
    let role = selection.role?;
    Some(Target::Role(if role == PLAN_ROLE {
        FALLBACK_ROLE.to_string()
    } else {
        role.to_string()
    }))
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
            apply: selection.pinned || selection.role != Some(PLAN_ROLE),
        },
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
    let model = registry.get_session(agent.session_id())?.last_model.as_ref()?;
    Some((model.provider.clone(), model.id.clone()))
}

/// Runs at every launch, after the role is seeded; the launch's closing drain applies what it queues.
pub(super) async fn on_launch(agent: &SessionAgent) {
    let launched_plan = crate::session::working_mode::launched_plan(agent).await;
    let swap = agent.with_model_state(|s| s.plan_swap.clone()).await;
    if launched_plan == swap.is_some() {
        return;
    }
    let (pinned, role) = model_support::resolve_current_selection(agent).await;
    let last = last_model(agent).await;
    let selection = Selection {
        pinned,
        role: role.as_deref(),
        last_model: last.as_ref().map(|(p, i)| (p.as_str(), i.as_str())),
    };
    // Only an entering launch needs omp's role map, so a restart inside a plan stint skips the read.
    let plan_configured = if launched_plan {
        match crate::ipc::model_roles::get_model_roles_reliable().await {
            Ok(map) => model_support::resolve_role_selector(&map, PLAN_ROLE).is_some(),
            Err(err) => {
                log::warn!("plan_role: could not read the model roles: {err}");
                false
            }
        }
    } else {
        false
    };
    match step(launched_plan, swap.as_ref(), &selection, plan_configured) {
        Step::Keep => {}
        Step::Enter { swap, apply } => {
            agent.with_model_state(|s| s.plan_swap = Some(swap)).await;
            if apply {
                crate::session::pending_selection::queue(agent, Target::Role(PLAN_ROLE.to_string()))
                    .await;
            }
        }
        Step::Leave { restore } => {
            agent.with_model_state(|s| s.plan_swap = None).await;
            if let Some(target) = restore {
                crate::session::pending_selection::queue(agent, target).await;
            }
        }
        Step::Forget => agent.with_model_state(|s| s.plan_swap = None).await,
    }
}

#[cfg(test)]
#[path = "plan_role.test.rs"]
mod tests;
