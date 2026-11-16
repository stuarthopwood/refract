// `gh pr` list/search/view/staleness/files; the core `gh` wrapper is in `gh.rs`, mutations in
// `gh_mutations.rs` (split for the 600-line cap, #806).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex as StdMutex};

use serde::Deserialize;

use super::gh::{gh_json, owner_repo_for, GhActor, GhCheckRun, GhError, GhLabel};

/// `gh pr list --json <LIST_FIELDS>`.
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

/// Passes `--state <state>` straight to `gh` so the 50-row limit applies to that state (#499).
pub async fn list_pull_requests_by_state(
    repo_path: &Path,
    state: &str,
) -> Result<Vec<GhPrListEntry>, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    gh_json(
        repo_path,
        &[
            "pr",
            "list",
            "--repo",
            &format!("{owner}/{repo}"),
            "--state",
            state,
            "--limit",
            "50",
            "--json",
            LIST_FIELDS,
        ],
    )
    .await
}

/// The three fields stack chaining needs; a slim read of the open pull requests (#1867).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStackRefEntry {
    pub number: u64,
    pub head_ref_name: String,
    pub base_ref_name: String,
}

/// Capped at 50 open pull requests, like `list_pull_requests_by_state`.
pub async fn list_stack_refs(repo_path: &Path) -> Result<Vec<GhStackRefEntry>, GhError> {
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
            "number,headRefName,baseRefName",
        ],
    )
    .await
}

/// `gh search prs --repo <repo> "<qualifier>" --json <SEARCH_FIELDS>`: a narrower field set than
/// `gh pr list --json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSearchEntry {
    pub number: u64,
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    pub author: GhActor,
    pub url: String,
    pub updated_at: String,
    pub labels: Vec<GhLabel>,
}

const SEARCH_FIELDS: &str = "number,title,state,isDraft,author,url,updatedAt,labels";

/// Built-in `@me` narrowing qualifiers: author, assignee, involves, review-requested.
#[derive(Debug, Clone, Copy)]
pub enum SearchQualifierFlag {
    Author,
    Assignee,
    Involves,
    ReviewRequested,
}

impl SearchQualifierFlag {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Author => "--author",
            Self::Assignee => "--assignee",
            Self::Involves => "--involves",
            Self::ReviewRequested => "--review-requested",
        }
    }
}

/// Flags go before `--`; `gh search prs` misparses a qualifier joined to free text, and `-label:bug`
/// needs `--` to not read as a flag.
pub async fn search_pull_requests(
    repo_path: &Path,
    qualifier_flag: SearchQualifierFlag,
    state: Option<&str>,
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
    ];
    // "All" omits `--state` (gh's default); `--state closed` already includes merged.
    if let Some(state) = state {
        args.push("--state");
        args.push(state);
    }
    args.push("--json");
    args.push(SEARCH_FIELDS);
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

/// Cached per `(owner_repo, number)` and invalidated when `updated_at` moves, so a refresh does not
/// respawn `gh pr view` per row. Search has no `statusCheckRollup`; takes a pre-resolved `owner/repo`.
struct CachedCheckState {
    updated_at: String,
    status_check_rollup: Option<Vec<GhCheckRun>>,
}

/// Bounded by clearing the whole map; a miss only costs one more `gh pr view`.
const CHECK_STATE_CACHE_CAP: usize = 500;

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
    {
        let mut cache = CHECK_STATE_CACHE
            .lock()
            .expect("CHECK_STATE_CACHE mutex poisoned");
        if !cache.contains_key(&key) && cache.len() >= CHECK_STATE_CACHE_CAP {
            cache.clear();
        }
        cache.insert(
            key,
            CachedCheckState {
                updated_at: updated_at.to_string(),
                status_check_rollup: result.status_check_rollup.clone(),
            },
        );
    }
    Ok(result.status_check_rollup)
}

/// No `reviews` field: `submittedAt` is `null` for a pending review, which a required `String`
/// cannot deserialise and would break `detail()`; the timeline comes from `gh_mutations`.
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

/// `gh pr view --json <VIEW_FIELDS>`; `files` never carries `patch`.
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
    /// True for a fork PR, whose code a "New session" would run an agent against untrusted.
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

/// Cheap staleness re-fetch of only the fields a mutation compares or needs for disabled reasons.
/// `id` lets the approve path pin its mutation to the reviewed commit via `commitOID`.
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

/// REST `pulls/<number>/files`, the only surface carrying `patch`; `None` on any failure.
/// `--paginate` avoids truncation; no `-f per_page`, as any `-f` makes `gh api` POST (404).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gh_staleness_check_wire_deserialises_camel_case_including_head_ref_oid_rename() {
        // Shaped like `gh pr view --json id,updatedAt,headRefOid,mergeable,mergeStateStatus,isDraft,state`.
        let json = r#"{
            "id": "PR_kwDO1234",
            "updatedAt": "2024-06-01T12:00:00Z",
            "headRefOid": "deadbeefcafe",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "isDraft": false,
            "state": "OPEN"
        }"#;
        let wire: GhStalenessCheckWire =
            serde_json::from_str(json).expect("GhStalenessCheckWire fixture parses");
        assert_eq!(wire.id, "PR_kwDO1234");
        assert_eq!(wire.updated_at, "2024-06-01T12:00:00Z");
        assert_eq!(wire.head_ref_oid, "deadbeefcafe");
        assert_eq!(wire.mergeable, "MERGEABLE");
        assert_eq!(wire.merge_state_status, "CLEAN");
        assert!(!wire.is_draft);
        assert_eq!(wire.state, "OPEN");
    }
}
