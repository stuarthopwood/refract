// Stacked pull request view and merge through `gh stack` (#1867, spec 132).

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use super::gh::{gh_raw, map_gh_failure, non_empty_or, owner_repo_for, GhError, GhErrorCode};
use super::gh_stack_state;
use super::stacks::{self, view_stack, ViewOutcome};

/// A stack merge rebases and merges every layer, far beyond `gh_raw`'s 15 s default.
const MERGE_TIMEOUT: Duration = Duration::from_secs(120);

/// Which merge path a pull request takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Stack,
    Plain,
}

/// A successful view beats a stale renderer hint; with no view the hint decides.
pub fn route(view: &ViewOutcome, number: u64, hint_stacked: bool) -> Route {
    match view {
        ViewOutcome::Stacked(v)
            if v.branches
                .iter()
                .any(|b| b.pr.as_ref().is_some_and(|p| p.number == number)) =>
        {
            Route::Stack
        }
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

/// Runs exactly one merge path. A failed stack merge is returned as is: it may have landed
/// lower layers, so the plain merge is never attempted afterwards.
pub async fn run_route<S, P>(route: Route, stack: S, plain: P) -> Result<(), GhError>
where
    S: Future<Output = Result<(), GhError>>,
    P: Future<Output = Result<(), GhError>>,
{
    match route {
        Route::Stack => stack.await,
        Route::Plain => plain.await,
    }
}

/// Decides the route for a merge and whether the stack path is allowed at all.
pub async fn route_for(
    repo_path: &Path,
    number: u64,
    head_branch: &str,
    hint_stacked: bool,
    setting_on: bool,
) -> Route {
    if !setting_on {
        return Route::Plain;
    }
    let (owner, repo) = match owner_repo_for(repo_path).await {
        Ok(pair) => pair,
        Err(_) => return Route::Plain,
    };
    let runtime = gh_stack_state::runtime();
    if runtime.is_unavailable(&owner, &repo)
        || !matches!(
            gh_stack_state::state(runtime).await,
            Ok(gh_stack_state::GhStackState::Ready)
        )
    {
        return Route::Plain;
    }
    route(
        &view_stack(repo_path, head_branch).await,
        number,
        hint_stacked,
    )
}

pub async fn merge_stacked(repo_path: &Path, number: u64) -> Result<(), GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    stacks::guard_stack_number(repo_path, &owner, &repo, number).await?;
    let argv = merge_argv(number);
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let result = gh_raw(repo_path, &args, None, MERGE_TIMEOUT).await?;
    if result.timed_out {
        return Err(GhError::new(
            GhErrorCode::Timeout,
            "The stack merge timed out.",
        ));
    }
    if marks_unavailable(result.code) {
        gh_stack_state::runtime().mark_unavailable(&owner, &repo);
    }
    if result.code != 0 {
        return Err(map_merge_failure(
            result.code,
            &result.stderr,
            &result.stdout,
        ));
    }
    Ok(())
}

/// Exit 9 (stacks API 404) disables stacks for that repository until relaunch.
pub fn marks_unavailable(code: i32) -> bool {
    code == 9
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::stacks::parse_view;

    const THREE: &str = r#"{"trunk":"main","currentBranch":"b","branches":[{"name":"a","pr":{"number":1}},{"name":"b","pr":{"number":2}},{"name":"c","pr":{"number":3}}]}"#;

    #[test]
    fn stacked_argv_is_exact() {
        assert_eq!(merge_argv(7), ["stack", "merge", "7", "--yes", "--squash"]);
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
    fn exit_nine_says_plain_pull_requests_will_be_used_and_marks_the_repository() {
        let err = map_merge_failure(9, "", "");
        assert!(err.message.contains("not enabled"));
        assert!(marks_unavailable(9));
        assert!(!marks_unavailable(3) && !marks_unavailable(0));
    }

    #[test]
    fn exit_two_and_the_conflict_codes_map_to_not_mergeable() {
        assert_eq!(map_merge_failure(2, "", "").code, GhErrorCode::NotMergeable);
        for code in [3, 7, 10] {
            assert_eq!(
                map_merge_failure(code, "conflict", "").code,
                GhErrorCode::NotMergeable
            );
        }
    }

    #[tokio::test]
    async fn a_failed_stack_merge_never_falls_back_to_a_plain_merge() {
        let plain_ran = std::sync::atomic::AtomicBool::new(false);
        let stack = async { Err(GhError::new(GhErrorCode::NotMergeable, "conflict")) };
        let plain = async {
            plain_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        };
        assert!(run_route(Route::Stack, stack, plain).await.is_err());
        assert!(!plain_ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn the_plain_route_never_runs_the_stack_merge() {
        let stack_ran = std::sync::atomic::AtomicBool::new(false);
        let stack = async {
            stack_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        };
        assert!(run_route(Route::Plain, stack, async { Ok(()) })
            .await
            .is_ok());
        assert!(!stack_ran.load(std::sync::atomic::Ordering::SeqCst));
    }
}
