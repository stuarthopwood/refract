// Per-check mapping for `PullRequestDetail.checks` (spec 038, FR-011/FR-012): one entry per
// `statusCheckRollup` item. The aggregate `checkState` stays in `mapping.rs::map_check_state`.

use serde::Serialize;

use crate::github::gh::GhCheckRun;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckOutcome {
    ActionRequired,
    Failing,
    Pending,
    Successful,
    Neutral,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub outcome: CheckOutcome,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub details_url: Option<String>,
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.filter(|v| !v.is_empty()).cloned()
}

fn map_check_outcome(run: &GhCheckRun) -> CheckOutcome {
    let status = run.status.as_deref().unwrap_or("").to_uppercase();
    let conclusion = run.conclusion.as_deref().unwrap_or("").to_uppercase();
    let state = run.state.as_deref().unwrap_or("").to_uppercase();
    // A `StatusContext` has only `state`; a `CheckRun` has `status` plus (once completed)
    // `conclusion`.
    if !state.is_empty() {
        return match state.as_str() {
            "SUCCESS" => CheckOutcome::Successful,
            "FAILURE" | "ERROR" => CheckOutcome::Failing,
            _ => CheckOutcome::Pending,
        };
    }
    if status != "COMPLETED" {
        return CheckOutcome::Pending;
    }
    match conclusion.as_str() {
        "SUCCESS" => CheckOutcome::Successful,
        "NEUTRAL" | "STALE" => CheckOutcome::Neutral,
        "SKIPPED" => CheckOutcome::Skipped,
        "ACTION_REQUIRED" => CheckOutcome::ActionRequired,
        "" => CheckOutcome::Pending,
        _ => CheckOutcome::Failing,
    }
}

pub fn map_checks(runs: Option<&[GhCheckRun]>) -> Vec<PullRequestCheck> {
    runs.unwrap_or(&[])
        .iter()
        .map(|run| PullRequestCheck {
            name: non_empty(run.name.as_ref())
                .or_else(|| non_empty(run.context.as_ref()))
                .unwrap_or_else(|| "Check".to_string()),
            outcome: map_check_outcome(run),
            started_at: non_empty(run.started_at.as_ref()),
            completed_at: non_empty(run.completed_at.as_ref()),
            details_url: non_empty(run.details_url.as_ref())
                .or_else(|| non_empty(run.target_url.as_ref())),
        })
        .collect()
}
