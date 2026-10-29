// IPC handler bodies for `pullRequests.*` (lane R9, issue #792). Split out of `mod.rs` to stay
// under the 600-line-per-file cap (issue #806): `mod.rs` keeps registration, the staleness
// cache, `list_pull_requests`/`build_detail`'s own orchestration, and the small validation/
// lookup helpers every handler below calls into via `super::`.

use serde_json::Value;

use crate::git::worktrees::{add_worktree_from_pull_request_branch, remove_worktree};
use crate::github::gh_mutations::{self, MergeMethod, PinnedReview, ReviewVerdict};
use crate::github::gh_pull_requests;
use crate::ipc::{
    invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    HandlerFuture, IpcError,
};
use crate::store::registry::Session;

use super::mapping::{
    self, compute_merge_disabled_reason, compute_review_disabled_reason, map_mergeable_state,
    map_pull_request_state, PullRequestListResult,
};
use super::{
    build_detail, check_not_stale, forget_cache, list_pull_requests, map_gh_error,
    parse_filter_tab, remember_fresh, repo_path_for, stale_error, valid_pull_request_number,
    STALE_ERROR, STALE_ERROR_DIALOG, STALE_ERROR_DIALOG_MOVED,
};

/// Issue #499 (2026-10-16 decision): the State control narrowing whichever Filter tab is
/// active; `Closed` includes Merged (decided 2026-10-07).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PullRequestStateFilter {
    Open,
    Closed,
    All,
}

fn parse_state_filter(value: &str) -> Option<PullRequestStateFilter> {
    match value {
        "open" => Some(PullRequestStateFilter::Open),
        "closed" => Some(PullRequestStateFilter::Closed),
        "all" => Some(PullRequestStateFilter::All),
        _ => None,
    }
}

pub(super) fn pull_requests_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "pullRequests.list expects (repositoryId, tab, state, query?)";
        let repository_id = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let tab = args
            .get(1)
            .and_then(Value::as_str)
            .and_then(parse_filter_tab)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let state_filter = args
            .get(2)
            .and_then(Value::as_str)
            .and_then(parse_state_filter)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let query = match args.get(3) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            Some(_) => {
                return Err(invalid_argument(
                    "pullRequests.list expects query to be a string when provided",
                ))
            }
        };
        let (repo_path, repo_label) = repo_path_for(&state, repository_id).await?;
        let items = list_pull_requests(&repo_path, &repo_label, tab, state_filter, query)
            .await
            .map_err(map_gh_error)?;
        let result = PullRequestListResult {
            items,
            fetched_at: now_iso8601(),
        };
        Ok(
            serde_json::to_value(result)
                .expect("PullRequestListResult is always JSON-serialisable"),
        )
    })
}

pub(super) fn pull_requests_detail(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument("pullRequests.detail expects (repositoryId, number)")
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument("pullRequests.detail expects (repositoryId, number)")
        })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let detail = build_detail(&repo_path, number)
            .await
            .map_err(map_gh_error)?;
        remember_fresh(
            repository_id,
            number,
            detail.updated_at.clone(),
            detail.head_sha.clone(),
        );
        Ok(serde_json::to_value(&detail).expect("PullRequestDetail is always JSON-serialisable"))
    })
}

pub(super) fn pull_requests_comment(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument("pullRequests.comment expects (repositoryId, number, body)")
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument("pullRequests.comment expects (repositoryId, number, body)")
        })?;
        let body = args.get(2).and_then(Value::as_str).ok_or_else(|| {
            invalid_argument("pullRequests.comment expects (repositoryId, number, body)")
        })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, _) = check_not_stale(repository_id, &repo_path, number, false)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR));
        }
        gh_mutations::comment_on_pull_request(&repo_path, number, body)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(serde_json::json!({ "id": uuid::Uuid::new_v4().to_string() }))
    })
}

pub(super) fn pull_requests_reply_to_thread(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.replyToThread expects (repositoryId, number, threadId, body)",
            )
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument(
                "pullRequests.replyToThread expects (repositoryId, number, threadId, body)",
            )
        })?;
        let thread_id = args.get(2).and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.replyToThread expects (repositoryId, number, threadId, body)",
            )
        })?;
        let body = args.get(3).and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.replyToThread expects (repositoryId, number, threadId, body)",
            )
        })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, _) = check_not_stale(repository_id, &repo_path, number, false)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR));
        }
        let threads_and_timeline =
            gh_mutations::get_review_threads_and_timeline(&repo_path, number)
                .await
                .map_err(map_gh_error)?;
        let thread = threads_and_timeline
            .review_threads
            .nodes
            .iter()
            .find(|node| node.id == thread_id)
            .ok_or_else(|| not_found(format!("Review thread not found: {thread_id}")))?;
        let opening_comment_id = thread
            .comments
            .nodes
            .first()
            .ok_or_else(|| not_found(format!("Review thread not found: {thread_id}")))?
            .id
            .clone();
        let reply_id = gh_mutations::reply_to_thread_mutation(
            &repo_path,
            &threads_and_timeline.id,
            &opening_comment_id,
            body,
        )
        .await
        .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(serde_json::json!({ "id": reply_id }))
    })
}

pub(super) fn pull_requests_resolve_thread(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument("pullRequests.resolveThread expects (repositoryId, number, threadId)")
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument("pullRequests.resolveThread expects (repositoryId, number, threadId)")
        })?;
        let thread_id = args.get(2).and_then(Value::as_str).ok_or_else(|| {
            invalid_argument("pullRequests.resolveThread expects (repositoryId, number, threadId)")
        })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, _) = check_not_stale(repository_id, &repo_path, number, false)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR));
        }
        // Security remediation (Constitution Principle V): `threadId` must be verified to belong
        // to THIS pull request before the mutation, never trusted straight from the renderer.
        let threads_and_timeline =
            gh_mutations::get_review_threads_and_timeline(&repo_path, number)
                .await
                .map_err(map_gh_error)?;
        if !threads_and_timeline
            .review_threads
            .nodes
            .iter()
            .any(|node| node.id == thread_id)
        {
            return Err(not_found(format!("Review thread not found: {thread_id}")));
        }
        gh_mutations::resolve_review_thread_mutation(&repo_path, thread_id)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(Value::Null)
    })
}

pub(super) fn pull_requests_unresolve_thread(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.unresolveThread expects (repositoryId, number, threadId)",
            )
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument(
                "pullRequests.unresolveThread expects (repositoryId, number, threadId)",
            )
        })?;
        let thread_id = args.get(2).and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.unresolveThread expects (repositoryId, number, threadId)",
            )
        })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, _) = check_not_stale(repository_id, &repo_path, number, false)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR));
        }
        let threads_and_timeline =
            gh_mutations::get_review_threads_and_timeline(&repo_path, number)
                .await
                .map_err(map_gh_error)?;
        if !threads_and_timeline
            .review_threads
            .nodes
            .iter()
            .any(|node| node.id == thread_id)
        {
            return Err(not_found(format!("Review thread not found: {thread_id}")));
        }
        gh_mutations::unresolve_review_thread_mutation(&repo_path, thread_id)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(Value::Null)
    })
}

pub(super) fn pull_requests_submit_review(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.submitReview expects (repositoryId, number, { verdict, body?, expectedHeadSha })",
            )
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument(
                "pullRequests.submitReview expects (repositoryId, number, { verdict, body?, expectedHeadSha })",
            )
        })?;
        let input = args.get(2).and_then(Value::as_object).ok_or_else(|| {
            invalid_argument(
                "pullRequests.submitReview expects (repositoryId, number, { verdict, body?, expectedHeadSha })",
            )
        })?;
        let verdict = match input.get("verdict").and_then(Value::as_str) {
            Some("comment") => ReviewVerdict::Comment,
            Some("approve") => ReviewVerdict::Approve,
            Some("request-changes") => ReviewVerdict::RequestChanges,
            _ => {
                return Err(invalid_argument(
                    "pullRequests.submitReview expects verdict to be 'comment' | 'approve' | 'request-changes'",
                ))
            }
        };
        let body = match input.get("body") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            Some(_) => {
                return Err(invalid_argument(
                    "pullRequests.submitReview expects body to be a string when provided",
                ))
            }
        };
        let expected_head_sha = input
            .get("expectedHeadSha")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                invalid_argument(
                    "pullRequests.submitReview expects expectedHeadSha to be a non-empty string",
                )
            })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        // Security remediation: requires a cache entry (`detail()` must have been called for
        // this exact pull request before any review is submitted) so approve has a known
        // `headSha`/`id` to pin its `commitOID` to -- a missing entry is `stale`.
        let (stale, fresh) = check_not_stale(repository_id, &repo_path, number, true)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR_DIALOG));
        }
        // High remediation: the cache-vs-cache check above only proves a cache entry exists --
        // `expectedHeadSha` is the renderer's own dialog-open-time snapshot, compared here
        // against a FRESH re-fetch, which is the actual guarantee against a push that landed and
        // got re-cached as "fresh" by the 15s background poll while the dialog was open.
        if fresh.head_sha != expected_head_sha {
            return Err(stale_error(STALE_ERROR_DIALOG_MOVED));
        }
        let pr_state = map_pull_request_state(&fresh.state, fresh.is_draft);
        if let Some(reason) = compute_review_disabled_reason(pr_state) {
            return Err(IpcError::new("disabled", reason));
        }
        let pinned = if verdict == ReviewVerdict::Approve {
            Some(PinnedReview {
                pull_request_id: &fresh.id,
                head_sha: expected_head_sha,
            })
        } else {
            None
        };
        gh_mutations::submit_review(&repo_path, number, verdict, body, pinned)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(serde_json::json!({ "id": uuid::Uuid::new_v4().to_string() }))
    })
}

pub(super) fn pull_requests_merge(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.merge expects (repositoryId, number, { method, expectedHeadSha })",
            )
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument(
                "pullRequests.merge expects (repositoryId, number, { method, expectedHeadSha })",
            )
        })?;
        let input = args.get(2).and_then(Value::as_object).ok_or_else(|| {
            invalid_argument(
                "pullRequests.merge expects (repositoryId, number, { method, expectedHeadSha })",
            )
        })?;
        let method = input
            .get("method")
            .and_then(Value::as_str)
            .and_then(MergeMethod::parse)
            .ok_or_else(|| {
                invalid_argument(
                    "pullRequests.merge expects method to be 'merge' | 'squash' | 'rebase'",
                )
            })?;
        let expected_head_sha = input
            .get("expectedHeadSha")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                invalid_argument(
                    "pullRequests.merge expects expectedHeadSha to be a non-empty string",
                )
            })?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, fresh) = check_not_stale(repository_id, &repo_path, number, true)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR_DIALOG));
        }
        if fresh.head_sha != expected_head_sha {
            return Err(stale_error(STALE_ERROR_DIALOG_MOVED));
        }
        let pr_state = map_pull_request_state(&fresh.state, fresh.is_draft);
        let mergeable_state = map_mergeable_state(&fresh.mergeable);
        if let Some(reason) =
            compute_merge_disabled_reason(pr_state, &fresh.mergeable, &fresh.merge_state_status)
        {
            // Medium remediation: a conflict (GitHub itself refuses the merge) is `not-mergeable`
            // (FR-020); a review-state/BLOCKED gate is `disabled`, the same family as
            // `reviewDisabledReason`.
            let is_conflict = matches!(mergeable_state, mapping::MergeableState::Conflicting)
                || fresh.merge_state_status.eq_ignore_ascii_case("DIRTY");
            let code = if is_conflict {
                "not-mergeable"
            } else {
                "disabled"
            };
            return Err(IpcError::new(code, reason));
        }
        if matches!(mergeable_state, mapping::MergeableState::Unknown) {
            return Err(IpcError::new(
                "not-mergeable",
                "GitHub is still checking whether this pull request can merge; close this dialog, refresh, and try again shortly.",
            ));
        }
        // Pinned to the renderer's own dialog-open-time snapshot (just verified identical to
        // `fresh.head_sha` above), not `fresh.head_sha` alone.
        gh_mutations::merge_pull_request(&repo_path, number, method, expected_head_sha)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        Ok(Value::Null)
    })
}

pub(super) fn pull_requests_new_session_from_pull_request(
    state: AppState,
    args: Vec<Value>,
) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args.first().and_then(Value::as_str).ok_or_else(|| {
            invalid_argument(
                "pullRequests.newSessionFromPullRequest expects (repositoryId, number)",
            )
        })?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| {
            invalid_argument(
                "pullRequests.newSessionFromPullRequest expects (repositoryId, number)",
            )
        })?;
        let repository = {
            let registry = state.registry.lock().await;
            registry
                .get_repository(repository_id)
                .ok_or_else(|| not_found(format!("Repository not found: {repository_id}")))?
                .clone()
        };
        let repo_path = std::path::Path::new(&repository.path);

        // Gate round 3 HIGH (code review, 2026-10-14): the former two-step "resolve a free name
        // first, then fetch into it" sequence reserved nothing between the two steps, letting
        // two concurrent calls destroy each other's worktree/branch -- see
        // `add_worktree_from_pull_request_branch`'s own doc comment. It now does its own atomic
        // reservation internally; there is no separate name to resolve here any more.
        let added = add_worktree_from_pull_request_branch(repo_path, number)
            .await
            .map_err(map_git_error)?;
        let view = gh_pull_requests::view_pull_request_detail(repo_path, number)
            .await
            .ok();
        let now = now_iso8601();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id: repository_id.to_string(),
            name: added.branch.clone(),
            branch: added.branch.clone(),
            base_branch: view
                .as_ref()
                .map(|v| v.base_ref_name.clone())
                .unwrap_or_else(|| added.branch.clone()),
            worktree_path: added.worktree_path.to_string_lossy().into_owned(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: now.clone(),
            last_activity_at: now,
            archived_at: None,
            hidden_at: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
        };

        if let Err(err) = state
            .registry
            .lock()
            .await
            .add_session(session.clone())
            .await
        {
            // Security remediation (ported): the Repository may have been removed while the
            // worktree-creation steps above were still in flight -- roll back the worktree/
            // branch just created so it is not stranded.
            let _ = remove_worktree(repo_path, &added.worktree_path, &added.branch, true).await;
            return Err(map_registry_error(err));
        }
        state.session_manager.notify_list_changed();
        Ok(serde_json::to_value(session).expect("Session is always JSON-serialisable"))
    })
}

#[cfg(test)]
mod state_filter_tests {
    use super::*;

    #[test]
    fn parse_state_filter_accepts_every_valid_literal() {
        assert_eq!(
            parse_state_filter("open"),
            Some(PullRequestStateFilter::Open)
        );
        assert_eq!(
            parse_state_filter("closed"),
            Some(PullRequestStateFilter::Closed)
        );
        assert_eq!(parse_state_filter("all"), Some(PullRequestStateFilter::All));
    }

    #[test]
    fn parse_state_filter_rejects_unknown_and_empty() {
        assert_eq!(parse_state_filter("bogus"), None);
        assert_eq!(parse_state_filter(""), None);
    }
}
