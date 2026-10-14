// Port of `src/main/github/gh.ts`'s list/search/view/staleness/files surface (lane R9, issue
// #792), split out of `gh.rs` to stay under the 600-line-per-file cap (issue #806): the core
// timed `gh` wrapper (`gh_raw`/`gh_json`/`gh_graphql`/`owner_repo_for`) lives in `gh.rs`; the
// review-thread/timeline/comment/review/merge surface lives in `gh_mutations.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex as StdMutex};

use serde::Deserialize;

use super::gh::{gh_json, owner_repo_for, GhActor, GhCheckRun, GhError, GhLabel};

/// `gh pr list --json <LIST_FIELDS>` (docs/spike/FINDINGS.md row 37).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrListEntry {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub author: GhActor,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub updated_at: String,
    pub status_check_rollup: Option<Vec<GhCheckRun>>,
    pub labels: Vec<GhLabel>,
    pub review_requests: Vec<GhActor>,
    pub assignees: Vec<GhActor>,
}

const LIST_FIELDS: &str = "number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,statusCheckRollup,labels,reviewRequests,assignees";

/// `--state open` directly (not `--state all --limit 50` filtered client-side): scopes the whole
/// 50-row limit to open pull requests only.
pub async fn list_open_pull_requests(repo_path: &Path) -> Result<Vec<GhPrListEntry>, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    gh_json(
        repo_path,
        &[
            "pr",
            "list",
            "--repo",
            &format!("{owner}/{repo}"),
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            LIST_FIELDS,
        ],
    )
    .await
}

/// `gh search prs --repo <repo> "<qualifier>" --json <SEARCH_FIELDS>` (row 37): a narrower,
/// documented field set than `gh pr list --json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSearchEntry {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: GhActor,
    pub url: String,
    pub updated_at: String,
    pub labels: Vec<GhLabel>,
}

const SEARCH_FIELDS: &str = "number,title,state,author,url,updatedAt,labels";

/// One of the 4 built-in narrowing qualifiers this feature offers: `--author @me` /
/// `--assignee @me` / `--involves @me` / `--review-requested @me`.
#[derive(Debug, Clone, Copy)]
pub enum SearchQualifierFlag {
    Author,
    Assignee,
    Involves,
    ReviewRequested,
}

impl SearchQualifierFlag {
    fn as_str(self) -> &'static str {
        match self {
            Self::Author => "--author",
            Self::Assignee => "--assignee",
            Self::Involves => "--involves",
            Self::ReviewRequested => "--review-requested",
        }
    }
}

/// Every flag, `--json` included, is pushed before `--`; `--` and `query` are the final two argv
/// entries -- `gh search prs` genuinely misparses a qualifier/free-text pair joined into one argv
/// entry, and GitHub's own exclusion syntax (`-label:bug`) needs the `--` separator to not be
/// read as an unknown flag.
pub async fn search_pull_requests(
    repo_path: &Path,
    qualifier_flag: SearchQualifierFlag,
    query: Option<&str>,
) -> Result<Vec<GhSearchEntry>, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let owner_repo = format!("{owner}/{repo}");
    let mut args: Vec<&str> = vec![
        "search",
        "prs",
        "--repo",
        &owner_repo,
        qualifier_flag.as_str(),
        "@me",
        "--json",
        SEARCH_FIELDS,
    ];
    if let Some(query) = query {
        if !query.is_empty() {
            args.push("--");
            args.push(query);
        }
    }
    gh_json(repo_path, &args).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCheckStateResult {
    status_check_rollup: Option<Vec<GhCheckRun>>,
}

/// Perf finding (code review, 2026-10-14): cached per `(owner_repo, number)`, invalidated the
/// instant `updated_at` moves -- a non-Open tab used to spawn one `gh pr view` process per row
/// on EVERY list refresh, even when nothing about that pull request had changed since the last
/// refresh. The search surface has no `statusCheckRollup`; fetched per-row for these smaller,
/// non-Open tab result counts. Takes an already-resolved `owner/repo` so the caller resolves it
/// ONCE per request, not once per row.
struct CachedCheckState {
    updated_at: String,
    status_check_rollup: Option<Vec<GhCheckRun>>,
}

static CHECK_STATE_CACHE: LazyLock<StdMutex<HashMap<(String, u64), CachedCheckState>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

pub async fn view_check_state(
    repo_path: &Path,
    owner_repo: &str,
    number: u64,
    updated_at: &str,
) -> Result<Option<Vec<GhCheckRun>>, GhError> {
    let key = (owner_repo.to_string(), number);
    if let Some(cached) = CHECK_STATE_CACHE
        .lock()
        .expect("CHECK_STATE_CACHE mutex poisoned")
        .get(&key)
    {
        if cached.updated_at == updated_at {
            return Ok(cached.status_check_rollup.clone());
        }
    }
    let number_str = number.to_string();
    let result: GhCheckStateResult = gh_json(
        repo_path,
        &[
            "pr",
            "view",
            &number_str,
            "--repo",
            owner_repo,
            "--json",
            "statusCheckRollup",
        ],
    )
    .await?;
    CHECK_STATE_CACHE
        .lock()
        .expect("CHECK_STATE_CACHE mutex poisoned")
        .insert(
            key,
            CachedCheckState {
                updated_at: updated_at.to_string(),
                status_check_rollup: result.status_check_rollup.clone(),
            },
        );
    Ok(result.status_check_rollup)
}

/// "Also fix" remediation (code review, 2026-10-14): `GhReview`/`reviews` used to carry
/// `gh pr view --json reviews`'s submitted-review history, but nothing in `mapping.rs` ever read
/// it (the Overview timeline's reviews come from `gh_mutations`'s own GraphQL `timelineItems`
/// query instead) -- and `submittedAt` is `null` for a pending (not-yet-submitted) review, which
/// a required `String` field can never deserialise, breaking `detail()` outright whenever the
/// viewer has an in-progress review open in the GitHub web UI. Removed rather than made
/// `Option<String>`: dead code that can also crash is strictly worse than no code.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCommit {
    pub oid: String,
    #[serde(default)]
    pub message_headline: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRestFileLite {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    #[serde(default)]
    pub change_type: String,
}

/// `gh pr view --json <VIEW_FIELDS>` (row 38): `mergeable`/`mergeStateStatus` confirmed live as
/// `"MERGEABLE"`/`"CLEAN"` string enums on a clean PR; `files` never carries `patch`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrViewDetail {
    pub title: String,
    pub number: u64,
    pub state: String,
    pub author: GhActor,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub review_requests: Vec<GhActor>,
    pub assignees: Vec<GhActor>,
    pub labels: Vec<GhLabel>,
    pub commits: Vec<GhCommit>,
    pub merge_state_status: String,
    pub mergeable: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub files: Vec<GhRestFileLite>,
    pub is_draft: bool,
    pub status_check_rollup: Option<Vec<GhCheckRun>>,
    pub updated_at: String,
    pub head_ref_oid: String,
    pub body: String,
    /// `gh`'s own documented "head and base are in different repositories" flag -- true for a
    /// fork pull request, whose code a "New session" would check out and run an agent against
    /// untrusted.
    pub is_cross_repository: bool,
    pub head_repository_owner: Option<GhActor>,
}

const VIEW_FIELDS: &str = "title,number,state,author,baseRefName,headRefName,reviewRequests,assignees,labels,commits,mergeStateStatus,mergeable,additions,deletions,changedFiles,files,isDraft,statusCheckRollup,updatedAt,headRefOid,body,isCrossRepository,headRepositoryOwner";

pub async fn view_pull_request_detail(
    repo_path: &Path,
    number: u64,
) -> Result<GhPrViewDetail, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let number_str = number.to_string();
    gh_json(
        repo_path,
        &[
            "pr",
            "view",
            &number_str,
            "--repo",
            &format!("{owner}/{repo}"),
            "--json",
            VIEW_FIELDS,
        ],
    )
    .await
}

/// Cheap staleness re-fetch (FR-021): only the fields a mutating action compares against the
/// cache or needs to re-derive `reviewDisabledReason`/`mergeDisabledReason`, never the full
/// detail. `id` (the GraphQL node id) lets `submit_review`'s approve path pin its mutation to the
/// exact reviewed commit via `commitOID`.
pub struct GhStalenessCheck {
    pub id: String,
    pub updated_at: String,
    pub head_sha: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub is_draft: bool,
    pub state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhStalenessCheckWire {
    id: String,
    updated_at: String,
    head_ref_oid: String,
    mergeable: String,
    merge_state_status: String,
    is_draft: bool,
    state: String,
}

pub async fn view_staleness_check(
    repo_path: &Path,
    number: u64,
) -> Result<GhStalenessCheck, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let number_str = number.to_string();
    let result: GhStalenessCheckWire = gh_json(
        repo_path,
        &[
            "pr",
            "view",
            &number_str,
            "--repo",
            &format!("{owner}/{repo}"),
            "--json",
            "id,updatedAt,headRefOid,mergeable,mergeStateStatus,isDraft,state",
        ],
    )
    .await?;
    Ok(GhStalenessCheck {
        id: result.id,
        updated_at: result.updated_at,
        head_sha: result.head_ref_oid,
        mergeable: result.mergeable,
        merge_state_status: result.merge_state_status,
        is_draft: result.is_draft,
        state: result.state,
    })
}

/// REST `repos/<owner>/<repo>/pulls/<number>/files`: the only surface that carries `patch`;
/// absent (never `null`) once a file exceeds GitHub's per-file size threshold. Returns `None`
/// (never fails the caller) on any failure so it can fall back to the porcelain `files` field
/// (every `patch` absent) plus the FR-011 truncation banner.
///
/// `--paginate` (gh's own documented way to follow every `Link: rel="next"` page) so a pull
/// request with more than GitHub's default 30-per-page REST limit does not silently drop files
/// past the first page. No `-f per_page=100` alongside it: `gh api`'s own documented behaviour is
/// that ANY `-f`/`-F`/`--input` body parameter forces the request method to POST even for a
/// GET-only endpoint, which GitHub's REST API rejects with a 404 here -- `--paginate` already
/// appends its own `per_page=100` with no body parameter and no method change.
#[derive(Debug, Clone, Deserialize)]
pub struct GhRestFile {
    pub filename: String,
    pub additions: u64,
    pub deletions: u64,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default)]
    pub status: String,
}

pub async fn get_changed_files_with_patch(
    repo_path: &Path,
    number: u64,
) -> Option<Vec<GhRestFile>> {
    let (owner, repo) = owner_repo_for(repo_path).await.ok()?;
    gh_json(
        repo_path,
        &[
            "api",
            &format!("repos/{owner}/{repo}/pulls/{number}/files"),
            "--paginate",
        ],
    )
    .await
    .ok()
}
