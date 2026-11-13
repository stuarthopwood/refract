// Stacked pull request view and merge through `gh stack` (#1867, spec 132).

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::gh::{gh_raw, map_gh_failure, non_empty_or, owner_repo_for, GhError, GhErrorCode};
use super::gh_stack_state;

/// A stack merge rebases and merges every layer, far beyond `gh_raw`'s 15 s default.
const MERGE_TIMEOUT: Duration = Duration::from_secs(120);
const VIEW_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct StackView {
    pub branches: Vec<StackBranch>,
}

#[derive(Debug, Deserialize)]
pub struct StackBranch {
    pub name: String,
    #[serde(default)]
    pub pr: Option<StackPr>,
}

#[derive(Debug, Deserialize)]
pub struct StackPr {
    pub number: u64,
}

/// Which merge path a pull request takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Stack,
    Plain,
}

/// `gh stack view --json` exit 2 means "not in a stack"; any other failure is no answer.
pub enum ViewOutcome {
    Stacked(StackView),
    NotStacked,
    Unknown,
}

pub fn parse_view(code: i32, stdout: &str) -> ViewOutcome {
    match code {
        0 => serde_json::from_str(stdout)
            .map(ViewOutcome::Stacked)
            .unwrap_or(ViewOutcome::Unknown),
        2 => ViewOutcome::NotStacked,
        _ => ViewOutcome::Unknown,
    }
}

/// A successful view beats a stale renderer hint; with no view the hint decides.
pub fn route(view: &ViewOutcome, number: u64, hint_stacked: bool) -> Route {
    match view {
        ViewOutcome::Stacked(v) if v.branches.iter().any(|b| b.pr.as_ref().is_some_and(|p| p.number == number)) => Route::Stack,
        ViewOutcome::Stacked(_) | ViewOutcome::NotStacked => Route::Plain,
        ViewOutcome::Unknown if hint_stacked => Route::Stack,
        ViewOutcome::Unknown => Route::Plain,
    }
}

pub fn merge_argv(number: u64) -> Vec<String> {
    ["stack", "merge", &number.to_string(), "--yes", "--squash"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Maps a failed `gh stack merge` exit code; no fallback to `gh pr merge` follows any failure.
pub fn map_merge_failure(code: i32, stderr: &str, stdout: &str) -> GhError {
    let detail = non_empty_or(stderr, stdout, "gh stack merge failed.");
    match code {
        2 => GhError::new(GhErrorCode::NotMergeable, "This pull request is not in a stack."),
        3 | 7 | 10 => GhError::new(GhErrorCode::NotMergeable, detail),
        9 => GhError::new(
            GhErrorCode::GhFailed,
            "Stacked pull requests are not enabled for this repository; Refract will use plain pull requests here.",
        ),
        _ => map_gh_failure(stderr, stdout),
    }
}

pub async fn view_stack(repo_path: &Path, head_branch: &str) -> ViewOutcome {
    match gh_raw(repo_path, &["stack", "view", "--json", head_branch], None, VIEW_TIMEOUT).await {
        Ok(r) if !r.timed_out => parse_view(r.code, &r.stdout),
        _ => ViewOutcome::Unknown,
    }
}

/// Decides the route for a merge and whether the stack path is allowed at all.
pub async fn route_for(repo_path: &Path, number: u64, head_branch: &str, hint_stacked: bool, setting_on: bool) -> Route {
    if !setting_on {
        return Route::Plain;
    }
    let (owner, repo) = match owner_repo_for(repo_path).await {
        Ok(pair) => pair,
        Err(_) => return Route::Plain,
    };
    let runtime = gh_stack_state::runtime();
    if runtime.is_unavailable(&owner, &repo)
        || !matches!(gh_stack_state::state(runtime).await, Ok(gh_stack_state::GhStackState::Ready))
    {
        return Route::Plain;
    }
    route(&view_stack(repo_path, head_branch).await, number, hint_stacked)
}

pub async fn merge_stacked(repo_path: &Path, number: u64) -> Result<(), GhError> {
    let argv = merge_argv(number);
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let result = gh_raw(repo_path, &args, None, MERGE_TIMEOUT).await?;
    if result.timed_out {
        return Err(GhError::new(GhErrorCode::Timeout, "The stack merge timed out."));
    }
    if result.code == 9 {
        if let Ok((owner, repo)) = owner_repo_for(repo_path).await {
            gh_stack_state::runtime().mark_unavailable(&owner, &repo);
        }
    }
    if result.code != 0 {
        return Err(map_merge_failure(result.code, &result.stderr, &result.stdout));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREE: &str = r#"{"trunk":"main","currentBranch":"b","branches":[{"name":"a","pr":{"number":1}},{"name":"b","pr":{"number":2}},{"name":"c","pr":{"number":3}}]}"#;

    #[test]
    fn stacked_argv_is_exact() {
        assert_eq!(merge_argv(7), ["stack", "merge", "7", "--yes", "--squash"]);
    }

    #[test]
    fn exit_two_is_not_stacked_and_garbage_is_unknown() {
        assert!(matches!(parse_view(2, ""), ViewOutcome::NotStacked));
        assert!(matches!(parse_view(0, "nope"), ViewOutcome::Unknown));
        assert!(matches!(parse_view(4, ""), ViewOutcome::Unknown));
    }

    #[test]
    fn a_view_result_beats_a_stale_hint() {
        let stacked = parse_view(0, THREE);
        assert_eq!(route(&stacked, 2, false), Route::Stack);
        assert_eq!(route(&stacked, 9, true), Route::Plain);
        assert_eq!(route(&ViewOutcome::NotStacked, 2, true), Route::Plain);
    }

    #[test]
    fn with_no_view_the_hint_decides() {
        assert_eq!(route(&ViewOutcome::Unknown, 2, true), Route::Stack);
        assert_eq!(route(&ViewOutcome::Unknown, 2, false), Route::Plain);
    }

    #[test]
    fn exit_nine_says_plain_pull_requests_will_be_used() {
        let err = map_merge_failure(9, "", "");
        assert!(err.message.contains("not enabled"));
        assert_eq!(map_merge_failure(3, "conflict", "").code, GhErrorCode::NotMergeable);
    }
}
