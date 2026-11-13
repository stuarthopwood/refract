// Stack data from `gh stack view` and the stacks REST API (#1867, spec 132).

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use super::gh::{gh_raw, GhError, GhErrorCode};

const VIEW_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct StackView {
    pub branches: Vec<StackBranch>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackBranch {
    pub name: String,
    #[serde(default)]
    pub pr: Option<StackPr>,
    #[serde(default)]
    pub is_merged: bool,
    #[serde(default)]
    pub is_queued: bool,
    #[serde(default)]
    pub needs_rebase: bool,
}

#[derive(Debug, Deserialize)]
pub struct StackPr {
    pub number: u64,
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

pub async fn view_stack(repo_path: &Path, head_branch: &str) -> ViewOutcome {
    match gh_raw(repo_path, &["stack", "view", "--json", head_branch], None, VIEW_TIMEOUT).await {
        Ok(r) if !r.timed_out => parse_view(r.code, &r.stdout),
        _ => ViewOutcome::Unknown,
    }
}

/// `gh stack merge <n>` tries `n` as a stack number before a pull request number, so a stack
/// numbered `n` that is not this pull request's own stack would be merged by mistake.
/// The stacks response shape is unobserved (research.md), so "same stack" is deep JSON equality.
pub fn check_collision(by_number: Option<&Value>, by_pull_request: Option<&Value>, number: u64) -> Result<(), GhError> {
    let Some(owner_of_number) = by_number else {
        return Ok(());
    };
    let same = by_pull_request
        .and_then(Value::as_array)
        .is_some_and(|stacks| stacks.iter().any(|s| s == owner_of_number));
    if same {
        return Ok(());
    }
    Err(GhError::new(
        GhErrorCode::NotMergeable,
        format!("Stack {number} exists and is not the stack of pull request {number}; merge it from GitHub instead."),
    ))
}

async fn api_json(repo_path: &Path, path: &str) -> Option<Value> {
    let r = gh_raw(repo_path, &["api", path], None, VIEW_TIMEOUT).await.ok()?;
    if r.timed_out || r.code != 0 {
        return None;
    }
    serde_json::from_str(&r.stdout).ok()
}

pub async fn guard_stack_number(repo_path: &Path, owner: &str, repo: &str, number: u64) -> Result<(), GhError> {
    let by_number = api_json(repo_path, &format!("repos/{owner}/{repo}/stacks/{number}")).await;
    if by_number.is_none() {
        return Ok(());
    }
    let by_pr = api_json(repo_path, &format!("repos/{owner}/{repo}/stacks?pull_request={number}")).await;
    check_collision(by_number.as_ref(), by_pr.as_ref(), number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const THREE: &str = r#"{"trunk":"main","currentBranch":"b","branches":[
      {"name":"a","head":"h1","base":"main","isMerged":true,"pr":{"number":1,"state":"MERGED"}},
      {"name":"b","isQueued":true,"pr":{"number":2,"state":"QUEUED"}},
      {"name":"c","needsRebase":true,"pr":{"number":3,"state":"OPEN"}},
      {"name":"d"}]}"#;

    #[test]
    fn fixture_parses_three_layers_with_flags_and_an_unsubmitted_branch() {
        let ViewOutcome::Stacked(v) = parse_view(0, THREE) else { panic!("not stacked") };
        assert_eq!(v.branches.len(), 4);
        assert!(v.branches[0].is_merged && v.branches[1].is_queued && v.branches[2].needs_rebase);
        assert_eq!(v.branches[2].pr.as_ref().unwrap().number, 3);
        assert!(v.branches[3].pr.is_none());
    }

    #[test]
    fn exit_two_is_not_stacked_and_other_failures_are_unknown() {
        assert!(matches!(parse_view(2, ""), ViewOutcome::NotStacked));
        assert!(matches!(parse_view(0, "nope"), ViewOutcome::Unknown));
        assert!(matches!(parse_view(4, ""), ViewOutcome::Unknown));
        assert!(matches!(parse_view(9, ""), ViewOutcome::Unknown));
    }

    #[test]
    fn no_stack_with_that_number_is_safe() {
        assert!(check_collision(None, None, 7).is_ok());
    }

    #[test]
    fn the_pull_requests_own_stack_is_safe() {
        let s = json!({"id": 7, "pull_requests": [7, 8]});
        assert!(check_collision(Some(&s), Some(&json!([s.clone()])), 7).is_ok());
    }

    #[test]
    fn a_different_stack_owning_the_number_is_refused() {
        let other = json!({"id": 7, "pull_requests": [1, 2]});
        let mine = json!({"id": 3, "pull_requests": [7, 8]});
        let err = check_collision(Some(&other), Some(&json!([mine])), 7).unwrap_err();
        assert_eq!(err.code, GhErrorCode::NotMergeable);
    }

    #[test]
    fn an_unreadable_pull_request_lookup_refuses_rather_than_guesses() {
        let other = json!({"id": 7});
        assert!(check_collision(Some(&other), None, 7).is_err());
        assert!(check_collision(Some(&other), Some(&json!([])), 7).is_err());
    }
}
