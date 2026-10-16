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
/// `gh` argv construction. Capped at `i32::MAX`, not just "any `u64`": every mutation that needs
/// this number as a GraphQL variable sends it as an `Int` (`GraphqlValue::Int(number as i64)`),
/// GraphQL's own 32-bit signed integer type -- a number above that bound would silently wrap
/// when cast, never reaching `gh` as the value the renderer actually asked for.
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
            // Search results now carry `isDraft` directly (issue #529/#568 decision 6): a draft
            // pull request maps to `PullRequestState::Draft` here exactly as it does on the Open
            // tab, instead of silently showing as `Open`.
            state: map_pull_request_state(&entry.state, entry.is_draft),
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
    let stale = decide_stale(
        cached.as_ref(),
        &fresh.updated_at,
        &fresh.head_sha,
        require_cache_entry,
    );
    Ok((stale, fresh))
}

/// The FR-021 stale/not-stale decision itself, pulled out of `check_not_stale` as a pure
/// function so it is unit-testable without a `gh` process: `check_not_stale` has no fixture
/// seam (it calls `gh_pull_requests::view_staleness_check`, which spawns a real `gh`), but this
/// decision has no network dependency once the fresh staleness check's result is in hand.
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

pub(super) async fn build_detail(
    repo_path: &Path,
    number: u64,
) -> Result<PullRequestDetail, GhError> {
    let view_fut = gh_pull_requests::view_pull_request_detail(repo_path, number);
    let files_fut = gh_pull_requests::get_changed_files_with_patch(repo_path, number);
    let threads_fut = gh_mutations::get_review_threads_and_timeline(repo_path, number);
    let methods_fut = gh_mutations::get_allowed_merge_methods(repo_path);
    let owner_repo_fut = gh::owner_repo_for(repo_path);

    // Perf finding (code review, 2026-10-14): `files_fut` (an REST `--paginate` call, often the
    // slowest of the five) used to run only after every other detail call had already finished,
    // adding a full extra `gh` spawn plus API round trip to detail latency. It cannot join the
    // `GhError`-typed futures above directly (`get_changed_files_with_patch` never fails the
    // caller -- it resolves to `None` instead, so every caller falls back to the porcelain
    // `files` field), so the two futures run under a plain `tokio::join!` instead.
    let (result, files_with_patch) = tokio::join!(
        async { tokio::try_join!(view_fut, threads_fut, methods_fut, owner_repo_fut) },
        files_fut
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
        assert_eq!(parse_filter_tab("open"), Some(FilterTab::Open));
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
        // `map_gh_error` is a pure passthrough that trusts `GhError.message` is already
        // redacted (`gh::map_gh_failure`'s own job) -- this proves it never re-exposes a
        // secret-shaped substring that was already stripped before reaching this layer. Split
        // across fragments (same convention as `omp/redact_tests.rs`) so no single literal in
        // this source file reads as a real live credential.
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
        // GraphQL's `Int` is a 32-bit signed integer; every value above `i32::MAX` is rejected
        // here rather than silently wrapping when later cast to `i64` for a GraphQL variable.
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

    /// Round-trips `remember_fresh`/`forget_cache`/`cache_key` against the real `STALE_CACHE`
    /// static. Unique, UUID-like `repository_id`s so this never collides with another test's
    /// key under parallel execution.
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
