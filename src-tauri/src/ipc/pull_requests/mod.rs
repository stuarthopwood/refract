// IPC handlers for `pullRequests.*` (specs/003-pull-request-management/contracts/ipc.md, lane R9
// issue #792). The renderer never touches `gh`, the file system, or git directly (constitution
// V); every GitHub read/write here goes through `github::gh`/`github::gh_pull_requests`/
// `github::gh_mutations`. Maintains an in-memory staleness cache (data-model.md "Staleness
// (FR-021)") keyed by `(repositoryId, number)`: every mutating request re-fetches just
// `updatedAt`/`headSha` first and refuses with `'stale'` if either has moved since the last
// successful `detail()` call for that same pull request.
//
// Wire shapes and gh-wire-shape -> renderer-shape mapping live in the sibling `mapping.rs`
// (issue #806, keeps this file under the 600-line cap).

mod handlers;
mod mapping;

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::Value;

use crate::github::gh::{self, GhError};
use crate::github::gh_mutations;
use crate::github::gh_pull_requests::{self, GhStalenessCheck};

use super::{not_found, AppState, Dispatcher, IpcError};

use mapping::{
    build_timeline, compute_merge_disabled_reason, compute_review_disabled_reason, map_actor,
    map_changed_files, map_check_state, map_mergeable_state, map_pull_request_state,
    PullRequestDetail, PullRequestSummary,
};

pub fn register(d: &mut Dispatcher) {
    d.register("pullRequests.list", handlers::pull_requests_list);
    d.register("pullRequests.detail", handlers::pull_requests_detail);
    d.register("pullRequests.comment", handlers::pull_requests_comment);
    d.register("pullRequests.replyToThread", handlers::pull_requests_reply_to_thread);
    d.register("pullRequests.resolveThread", handlers::pull_requests_resolve_thread);
    d.register("pullRequests.unresolveThread", handlers::pull_requests_unresolve_thread);
    d.register("pullRequests.submitReview", handlers::pull_requests_submit_review);
    d.register("pullRequests.merge", handlers::pull_requests_merge);
    d.register(
        "pullRequests.newSessionFromPullRequest",
        handlers::pull_requests_new_session_from_pull_request,
    );
}

pub(super) fn map_gh_error(err: GhError) -> IpcError {
    IpcError::new(err.code.as_str(), err.message)
}

pub(super) const STALE_ERROR: &str = "This pull request has changed on GitHub; refresh before trying again.";
pub(super) const STALE_ERROR_DIALOG: &str =
    "This pull request has changed on GitHub; close this dialog, refresh, and try again.";
pub(super) const STALE_ERROR_DIALOG_MOVED: &str =
    "This pull request has changed on GitHub since you opened this dialog; close this dialog, refresh, and try again.";

pub(super) fn stale_error(message: &str) -> IpcError {
    IpcError::new("stale", message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FilterTab {
    Open,
    Authored,
    Assigned,
    Involves,
    ReviewRequested,
}

pub(super) fn parse_filter_tab(value: &str) -> Option<FilterTab> {
    match value {
        "open" => Some(FilterTab::Open),
        "authored" => Some(FilterTab::Authored),
        "assigned" => Some(FilterTab::Assigned),
        "involves" => Some(FilterTab::Involves),
        "review-requested" => Some(FilterTab::ReviewRequested),
        _ => None,
    }
}

/// "Also fix" remediation (ported from `pullRequests.ts`): `number` must be a positive integer
/// representable without precision loss, never `NaN`/negative/non-integer straight through to
/// `gh` argv construction.
pub(super) fn valid_pull_request_number(args: &[Value], index: usize) -> Option<u64> {
    args.get(index).and_then(Value::as_u64).filter(|&n| n > 0)
}

pub(super) async fn repo_path_for(state: &AppState, repository_id: &str) -> Result<(std::path::PathBuf, String), IpcError> {
    let registry = state.registry.lock().await;
    let repository = registry
        .get_repository(repository_id)
        .ok_or_else(|| not_found(format!("Repository not found: {repository_id}")))?;
    Ok((
        std::path::PathBuf::from(&repository.path),
        repository.name.clone(),
    ))
}

// ---------------------------------------------------------------------------
// List (FR-001 to FR-006)
// ---------------------------------------------------------------------------

/// High remediation (ported): a non-Open tab used to spawn one `gh pr view` process per row
/// sequentially (up to ~30 per tab switch) just to backfill the check-state the search surface
/// doesn't carry. Bounded to `CHECK_STATE_CONCURRENCY` concurrent spawns instead of unbounded.
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

pub(super) async fn list_pull_requests(
    repo_path: &Path,
    repo_label: &str,
    tab: FilterTab,
    query: Option<&str>,
) -> Result<Vec<PullRequestSummary>, GhError> {
    if tab == FilterTab::Open {
        let entries = gh_pull_requests::list_open_pull_requests(repo_path).await?;
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
        FilterTab::Open => unreachable!("Open is handled above"),
    };
    let entries = gh_pull_requests::search_pull_requests(repo_path, qualifier, query).await?;
    // The search surface has no `statusCheckRollup`; fetched per-row for these smaller, non-Open
    // tab result counts. `owner/repo` is resolved ONCE here, not per row.
    let (owner, repo) = gh::owner_repo_for(repo_path).await?;
    let owner_repo = format!("{owner}/{repo}");
    let numbers: Vec<u64> = entries.iter().map(|entry| entry.number).collect();
    let repo_path_owned = repo_path.to_path_buf();
    let check_states = with_bounded_concurrency(numbers, CHECK_STATE_CONCURRENCY, move |number| {
        let repo_path = repo_path_owned.clone();
        let owner_repo = owner_repo.clone();
        async move {
            gh_pull_requests::view_check_state(&repo_path, &owner_repo, number)
                .await
                .unwrap_or(None)
        }
    })
    .await;

    Ok(entries
        .into_iter()
        .zip(check_states)
        .map(|(entry, check_state)| PullRequestSummary {
            number: entry.number,
            title: entry.title,
            // The search surface has no `isDraft`/mergedAt distinction: a merged pull request may
            // show here as 'closed' rather than 'merged' -- a documented, known simplification.
            state: map_pull_request_state(&entry.state, false),
            check_state: map_check_state(check_state.as_deref()),
            repository: repo_label.to_string(),
            updated_at: entry.updated_at,
            author: map_actor(Some(&entry.author)),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Detail (FR-007 to FR-011) and the staleness cache (FR-021)
// ---------------------------------------------------------------------------

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

/// `requireCacheEntry` flips the no-cache-entry default for approve/merge specifically: those
/// two mutations are pinned to a cached commit (`headSha`/`id`), so a missing cache entry means
/// there is nothing to pin against and must be treated as stale rather than silently proceeding.
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
    let stale = match cached {
        None => require_cache_entry,
        Some(cached) => cached.updated_at != fresh.updated_at || cached.head_sha != fresh.head_sha,
    };
    Ok((stale, fresh))
}

pub(super) fn remember_fresh(repository_id: &str, number: u64, updated_at: String, head_sha: String) {
    STALE_CACHE.lock().expect("STALE_CACHE mutex poisoned").insert(
        cache_key(repository_id, number),
        StalenessEntry { updated_at, head_sha },
    );
}

/// "Also fix" remediation (ported): the cache used to be re-seeded with the PRE-mutation `fresh`
/// values right after a successful mutating call -- stale the instant that same action succeeded.
/// Deleting the entry instead forces the next `check_not_stale` to see "no cache entry" (lenient
/// for comment/reply/resolve/unresolve, strict-stale for approve/merge above); every mutating
/// handler's renderer caller already re-calls `detail()` immediately after success.
pub(super) fn forget_cache(repository_id: &str, number: u64) {
    STALE_CACHE
        .lock()
        .expect("STALE_CACHE mutex poisoned")
        .remove(&cache_key(repository_id, number));
}

pub(super) async fn build_detail(repo_path: &Path, number: u64) -> Result<PullRequestDetail, GhError> {
    let view_fut = gh_pull_requests::view_pull_request_detail(repo_path, number);
    let files_fut = gh_pull_requests::get_changed_files_with_patch(repo_path, number);
    let threads_fut = gh_mutations::get_review_threads_and_timeline(repo_path, number);
    let methods_fut = gh_mutations::get_allowed_merge_methods(repo_path);
    let owner_repo_fut = gh::owner_repo_for(repo_path);

    let (view, threads_and_timeline, allowed_merge_methods, owner_repo) =
        tokio::try_join!(view_fut, threads_fut, methods_fut, owner_repo_fut)?;
    let files_with_patch = files_fut.await;

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
        reviewers: view.review_requests.iter().map(|a| map_actor(Some(a))).collect(),
        assignees: view.assignees.iter().map(|a| map_actor(Some(a))).collect(),
        labels: view.labels.iter().map(|label| label.name.clone()).collect(),
        description: view.body.clone(),
        timeline,
        check_state: map_check_state(view.status_check_rollup.as_deref()),
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
        head_repository_owner: view.head_repository_owner.as_ref().map(|a| a.login.clone()),
    })
}
