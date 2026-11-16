// The renderer never touches `gh`; all GitHub access goes through `github::gh*`. Mutations
// refuse with `'stale'` if `updatedAt`/`headSha` moved since the last `detail()` (cache key above).

mod checks;
mod extra_handlers;
mod handlers;
mod mapping;
mod stack_refs_cache;

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::Value;

use crate::github::gh::{self, GhError};
use crate::github::gh_mutations;
use crate::github::gh_pull_requests::{self, GhStalenessCheck};
use crate::github::gh_viewer::viewer_login;

use super::{not_found, AppState, Dispatcher, IpcError};
use checks::map_checks;
use handlers::PullRequestStateFilter;

use mapping::{
    build_timeline, compute_merge_disabled_reason, compute_review_disabled_reason, map_actor,
    map_changed_files, map_check_state, map_mergeable_state, map_pull_request_state,
    PullRequestDetail, PullRequestSummary,
};

pub fn register(d: &mut Dispatcher) {
    d.register("pullRequests.list", handlers::pull_requests_list);
    d.register("pullRequests.detail", handlers::pull_requests_detail);
    d.register("pullRequests.comment", handlers::pull_requests_comment);
    extra_handlers::register(d);
    d.register(
        "pullRequests.replyToThread",
        handlers::pull_requests_reply_to_thread,
    );
    d.register(
        "pullRequests.resolveThread",
        handlers::pull_requests_resolve_thread,
    );
    d.register(
        "pullRequests.unresolveThread",
        handlers::pull_requests_unresolve_thread,
    );
    d.register(
        "pullRequests.submitReview",
        handlers::pull_requests_submit_review,
    );
    d.register("pullRequests.merge", handlers::pull_requests_merge);
    d.register(
        "pullRequests.newSessionFromPullRequest",
        handlers::pull_requests_new_session_from_pull_request,
    );
}

pub(super) fn map_gh_error(err: GhError) -> IpcError {
    IpcError::new(err.code.as_str(), err.message)
}

pub(super) const STALE_ERROR: &str =
    "This pull request has changed on GitHub; refresh before trying again.";
pub(super) const STALE_ERROR_DIALOG: &str =
    "This pull request has changed on GitHub; close this dialog, refresh, and try again.";
pub(super) const STALE_ERROR_DIALOG_MOVED: &str =
    "This pull request has changed on GitHub since you opened this dialog; close this dialog, refresh, and try again.";

pub(super) fn stale_error(message: &str) -> IpcError {
    IpcError::new("stale", message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FilterTab {
    All,
    Authored,
    Assigned,
    Involves,
    ReviewRequested,
}

pub(super) fn parse_filter_tab(value: &str) -> Option<FilterTab> {
    match value {
        "all" => Some(FilterTab::All),
        "authored" => Some(FilterTab::Authored),
        "assigned" => Some(FilterTab::Assigned),
        "involves" => Some(FilterTab::Involves),
        "review-requested" => Some(FilterTab::ReviewRequested),
        _ => None,
    }
}

/// Caps `number` at `i32::MAX`: GraphQL `Int` is 32-bit, so a larger value would wrap silently.
pub(super) fn valid_pull_request_number(args: &[Value], index: usize) -> Option<u64> {
    args.get(index)
        .and_then(Value::as_u64)
        .filter(|&n| n > 0 && n <= i32::MAX as u64)
}

pub(super) async fn repo_path_for(
    state: &AppState,
    repository_id: &str,
) -> Result<(std::path::PathBuf, String), IpcError> {
    let registry = state.registry.lock().await;
    let repository = registry
        .get_repository(repository_id)
        .ok_or_else(|| not_found(format!("Project not found: {repository_id}")))?;
    Ok((
        std::path::PathBuf::from(&repository.path),
        repository.name.clone(),
    ))
}

/// Bounds the per-row `gh pr view` spawns to `CHECK_STATE_CONCURRENCY`.
const CHECK_STATE_CONCURRENCY: usize = 8;

async fn with_bounded_concurrency<T, R, F, Fut>(items: Vec<T>, limit: usize, worker: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = R> + Send,
{
    let semaphore = Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
    let worker = Arc::new(worker);
    let mut handles = Vec::with_capacity(items.len());
    for item in items {
        let semaphore = semaphore.clone();
        let worker = worker.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .expect("CHECK_STATE_CONCURRENCY semaphore never closes");
            worker(item).await
        }));
    }
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.await.expect("check-state worker task panicked"));
    }
    results
}

pub(in crate::ipc::pull_requests) async fn list_pull_requests(
    repo_path: &Path,
    repo_label: &str,
    tab: FilterTab,
    state_filter: PullRequestStateFilter,
    query: Option<&str>,
) -> Result<Vec<PullRequestSummary>, GhError> {
    if tab == FilterTab::All {
        let gh_state = match state_filter {
            PullRequestStateFilter::Open => "open",
            PullRequestStateFilter::Closed => "closed",
            PullRequestStateFilter::All => "all",
        };
        let entries = gh_pull_requests::list_pull_requests_by_state(repo_path, gh_state).await?;
        let needle = query.map(str::to_lowercase).filter(|q| !q.is_empty());
        let mut items = Vec::new();
        for entry in entries {
            if let Some(needle) = &needle {
                let title_match = entry.title.to_lowercase().contains(needle.as_str());
                let label_match = entry
                    .labels
                    .iter()
                    .any(|label| label.name.to_lowercase().contains(needle.as_str()));
                if !title_match && !label_match {
                    continue;
                }
            }
            items.push(PullRequestSummary {
                number: entry.number,
                title: entry.title,
                state: map_pull_request_state(&entry.state, entry.is_draft),
                check_state: map_check_state(entry.status_check_rollup.as_deref()),
                repository: repo_label.to_string(),
                updated_at: entry.updated_at,
                author: map_actor(Some(&entry.author)),
            });
        }
        return Ok(items);
    }

    let qualifier = match tab {
        FilterTab::Authored => gh_pull_requests::SearchQualifierFlag::Author,
        FilterTab::Assigned => gh_pull_requests::SearchQualifierFlag::Assignee,
        FilterTab::Involves => gh_pull_requests::SearchQualifierFlag::Involves,
        FilterTab::ReviewRequested => gh_pull_requests::SearchQualifierFlag::ReviewRequested,
        FilterTab::All => unreachable!("All is handled above"),
    };
    let gh_state_arg = match state_filter {
        PullRequestStateFilter::Open => Some("open"),
        PullRequestStateFilter::Closed => Some("closed"),
        PullRequestStateFilter::All => None,
    };
    let entries =
        gh_pull_requests::search_pull_requests(repo_path, qualifier, gh_state_arg, query).await?;
    // The search surface has no `statusCheckRollup`, so it is fetched per row.
    let (owner, repo) = gh::owner_repo_for(repo_path).await?;
    let owner_repo = format!("{owner}/{repo}");
    let numbers_and_updated_at: Vec<(u64, String)> = entries
        .iter()
        .map(|entry| (entry.number, entry.updated_at.clone()))
        .collect();
    let repo_path_owned = repo_path.to_path_buf();
    let check_states = with_bounded_concurrency(
        numbers_and_updated_at,
        CHECK_STATE_CONCURRENCY,
        move |(number, updated_at)| {
            let repo_path = repo_path_owned.clone();
            let owner_repo = owner_repo.clone();
            async move {
                gh_pull_requests::view_check_state(&repo_path, &owner_repo, number, &updated_at)
                    .await
                    .unwrap_or(None)
            }
        },
    )
    .await;

    Ok(entries
        .into_iter()
        .zip(check_states)
        .map(|(entry, check_state)| PullRequestSummary {
            number: entry.number,
            title: entry.title,
            // Search results carry `isDraft`, so drafts map to `Draft` rather than `Open`.
            state: map_pull_request_state(&entry.state, entry.is_draft),
            check_state: map_check_state(check_state.as_deref()),
            repository: repo_label.to_string(),
            updated_at: entry.updated_at,
            author: map_actor(Some(&entry.author)),
        })
        .collect())
}

#[derive(Debug, Clone)]
struct StalenessEntry {
    updated_at: String,
    head_sha: String,
}

static STALE_CACHE: LazyLock<StdMutex<HashMap<String, StalenessEntry>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn cache_key(repository_id: &str, number: u64) -> String {
    format!("{repository_id}:{number}")
}

/// Approve and merge are pinned to a cached commit, so a missing entry counts as stale.
pub(super) async fn check_not_stale(
    repository_id: &str,
    repo_path: &Path,
    number: u64,
    require_cache_entry: bool,
) -> Result<(bool, GhStalenessCheck), GhError> {
    let fresh = gh_pull_requests::view_staleness_check(repo_path, number).await?;
    let cached = STALE_CACHE
        .lock()
        .expect("STALE_CACHE mutex poisoned")
        .get(&cache_key(repository_id, number))
        .cloned();
    let stale = decide_stale(
        cached.as_ref(),
        &fresh.updated_at,
        &fresh.head_sha,
        require_cache_entry,
    );
    Ok((stale, fresh))
}

/// Pure stale decision, split out so it can be unit-tested without spawning `gh`.
fn decide_stale(
    cached: Option<&StalenessEntry>,
    fresh_updated_at: &str,
    fresh_head_sha: &str,
    require_cache_entry: bool,
) -> bool {
    match cached {
        None => require_cache_entry,
        Some(cached) => cached.updated_at != fresh_updated_at || cached.head_sha != fresh_head_sha,
    }
}

pub(super) fn remember_fresh(
    repository_id: &str,
    number: u64,
    updated_at: String,
    head_sha: String,
) {
    STALE_CACHE
        .lock()
        .expect("STALE_CACHE mutex poisoned")
        .insert(
            cache_key(repository_id, number),
            StalenessEntry {
                updated_at,
                head_sha,
            },
        );
}

/// Deletes rather than re-seeds: re-seeding with pre-mutation values would be stale at once.
pub(super) fn forget_cache(repository_id: &str, number: u64) {
    STALE_CACHE
        .lock()
        .expect("STALE_CACHE mutex poisoned")
        .remove(&cache_key(repository_id, number));
    stack_refs_cache::shared().invalidate(repository_id);
}

/// Tells the renderer a PR was merged or closed so its lists refresh in the background.
pub(super) fn notify_changed(state: &crate::ipc::AppState, repository_id: &str, number: u64) {
    let handle = state
        .app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    if let Some(app) = handle {
        crate::events::emit_github_changed(&app, Some(repository_id), "pr", number);
    }
}

pub(super) async fn build_detail(
    repo_path: &Path,
    number: u64,
) -> Result<PullRequestDetail, GhError> {
    let view_fut = gh_pull_requests::view_pull_request_detail(repo_path, number);
    let files_fut = gh_pull_requests::get_changed_files_with_patch(repo_path, number);
    let threads_fut = gh_mutations::get_review_threads_and_timeline(repo_path, number);
    let methods_fut = gh_mutations::get_allowed_merge_methods(repo_path);
    let owner_repo_fut = gh::owner_repo_for(repo_path);
    let viewer_fut = viewer_login(repo_path);

    // Runs under a plain `tokio::join!`: its failure resolves to `None`, not a `GhError`.
    let (result, files_with_patch, viewer) = tokio::join!(
        async { tokio::try_join!(view_fut, threads_fut, methods_fut, owner_repo_fut) },
        files_fut,
        viewer_fut
    );
    let (view, threads_and_timeline, allowed_merge_methods, owner_repo) = result?;

    let state = map_pull_request_state(&view.state, view.is_draft);
    let mergeable_state = map_mergeable_state(&view.mergeable);
    let review_disabled_reason = compute_review_disabled_reason(state);
    let merge_disabled_reason =
        compute_merge_disabled_reason(state, &view.mergeable, &view.merge_state_status);
    let timeline = build_timeline(&threads_and_timeline);
    let (owner, repo) = owner_repo;

    Ok(PullRequestDetail {
        number: view.number,
        title: view.title.clone(),
        state,
        base_branch: view.base_ref_name.clone(),
        head_branch: view.head_ref_name.clone(),
        author: map_actor(Some(&view.author)),
        reviewers: view
            .review_requests
            .iter()
            .map(|a| map_actor(Some(a)))
            .collect(),
        assignees: view.assignees.iter().map(|a| map_actor(Some(a))).collect(),
        labels: view.labels.iter().map(|label| label.name.clone()).collect(),
        description: view.body.clone(),
        timeline,
        check_state: map_check_state(view.status_check_rollup.as_deref()),
        checks: map_checks(view.status_check_rollup.as_deref()),
        viewer_login: viewer,
        mergeable_state,
        review_disabled_reason,
        merge_disabled_reason,
        allowed_merge_methods,
        additions: view.additions,
        deletions: view.deletions,
        changed_files_count: view.changed_files,
        files: map_changed_files(&view, files_with_patch.as_deref()),
        url: format!("https://github.com/{owner}/{repo}/pull/{number}"),
        updated_at: view.updated_at.clone(),
        head_sha: view.head_ref_oid.clone(),
        is_fork: view.is_cross_repository,
        head_repository_owner: view.head_repository_owner.and_then(|a| a.login),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filter_tab_accepts_every_valid_literal() {
        assert_eq!(parse_filter_tab("all"), Some(FilterTab::All));
        assert_eq!(parse_filter_tab("authored"), Some(FilterTab::Authored));
        assert_eq!(parse_filter_tab("assigned"), Some(FilterTab::Assigned));
        assert_eq!(parse_filter_tab("involves"), Some(FilterTab::Involves));
        assert_eq!(
            parse_filter_tab("review-requested"),
            Some(FilterTab::ReviewRequested)
        );
    }

    #[test]
    fn parse_filter_tab_rejects_unknown_and_empty() {
        assert_eq!(parse_filter_tab("bogus"), None);
        assert_eq!(parse_filter_tab(""), None);
    }

    #[test]
    fn map_gh_error_preserves_redaction_for_a_token_shaped_message() {
        // Fragments are split so no single literal reads as a live credential.
        let token = format!("{}{}", "ghp_", "1234567890abcdef");
        let raw = format!("some unexpected gh error: {token}");
        let redacted_message = crate::omp::redact::redact_secrets(&raw);
        let err = GhError::new(gh::GhErrorCode::GithubFailed, redacted_message);
        let ipc_err = map_gh_error(err);
        assert!(!ipc_err.message.contains(&token));
    }

    #[test]
    fn valid_pull_request_number_accepts_positive_up_to_i32_max() {
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!(1)], 0),
            Some(1)
        );
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!(i32::MAX)], 0),
            Some(i32::MAX as u64)
        );
    }

    #[test]
    fn valid_pull_request_number_rejects_above_i32_max_and_u64_max() {
        // GraphQL `Int` is 32-bit; larger values must be rejected, not wrapped.
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!(i32::MAX as u64 + 1)], 0),
            None
        );
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!(u64::MAX)], 0),
            None
        );
    }

    #[test]
    fn valid_pull_request_number_rejects_zero_negative_fractional_and_string() {
        assert_eq!(valid_pull_request_number(&[serde_json::json!(0)], 0), None);
        assert_eq!(valid_pull_request_number(&[serde_json::json!(-1)], 0), None);
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!(1.5)], 0),
            None
        );
        assert_eq!(
            valid_pull_request_number(&[serde_json::json!("5")], 0),
            None
        );
    }

    #[test]
    fn valid_pull_request_number_rejects_missing_index() {
        assert_eq!(valid_pull_request_number(&[serde_json::json!(1)], 1), None);
    }

    #[test]
    fn decide_stale_no_cache_entry_respects_require_flag() {
        assert!(!decide_stale(None, "2024-01-01T00:00:00Z", "sha1", false));
        assert!(decide_stale(None, "2024-01-01T00:00:00Z", "sha1", true));
    }

    #[test]
    fn decide_stale_matching_cache_entry_is_never_stale_regardless_of_require_flag() {
        let cached = StalenessEntry {
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            head_sha: "sha1".to_string(),
        };
        assert!(!decide_stale(
            Some(&cached),
            "2024-01-01T00:00:00Z",
            "sha1",
            false
        ));
        assert!(!decide_stale(
            Some(&cached),
            "2024-01-01T00:00:00Z",
            "sha1",
            true
        ));
    }

    #[test]
    fn decide_stale_different_updated_at_is_stale() {
        let cached = StalenessEntry {
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            head_sha: "sha1".to_string(),
        };
        assert!(decide_stale(
            Some(&cached),
            "2024-02-01T00:00:00Z",
            "sha1",
            false
        ));
    }

    #[test]
    fn decide_stale_different_head_sha_only_is_stale() {
        let cached = StalenessEntry {
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            head_sha: "sha1".to_string(),
        };
        assert!(decide_stale(
            Some(&cached),
            "2024-01-01T00:00:00Z",
            "sha2",
            false
        ));
    }

    /// Uses unique repository ids so parallel tests do not share cache keys.
    #[test]
    fn remember_fresh_and_forget_cache_are_independent_per_repository() {
        let repo_a = "11111111-1111-4111-8111-111111111111";
        let repo_b = "22222222-2222-4222-8222-222222222222";
        remember_fresh(
            repo_a,
            1,
            "2024-01-01T00:00:00Z".to_string(),
            "sha-a".to_string(),
        );
        remember_fresh(
            repo_b,
            1,
            "2024-06-01T00:00:00Z".to_string(),
            "sha-b".to_string(),
        );

        {
            let cache = STALE_CACHE.lock().expect("STALE_CACHE mutex poisoned");
            let a = cache
                .get(&cache_key(repo_a, 1))
                .expect("repo_a entry present");
            assert_eq!(a.updated_at, "2024-01-01T00:00:00Z");
            assert_eq!(a.head_sha, "sha-a");
            let b = cache
                .get(&cache_key(repo_b, 1))
                .expect("repo_b entry present");
            assert_eq!(b.updated_at, "2024-06-01T00:00:00Z");
            assert_eq!(b.head_sha, "sha-b");
        }

        forget_cache(repo_a, 1);
        {
            let cache = STALE_CACHE.lock().expect("STALE_CACHE mutex poisoned");
            assert!(
                cache.get(&cache_key(repo_a, 1)).is_none(),
                "repo_a entry forgotten"
            );
            assert!(
                cache.get(&cache_key(repo_b, 1)).is_some(),
                "repo_b entry untouched"
            );
        }
        forget_cache(repo_b, 1);
    }
}
