// `gh search prs` across many repositories in ONE call (issue #874, spec 057): the cross-Project
// Pull requests view passes one `--repo` per distinct owner/repo instead of spawning one search
// per Project, and checks the search rate limit first (search has its own, much smaller, budget).

use std::path::Path;

use serde::Deserialize;

use super::gh::{gh_json, GhActor, GhError, GhErrorCode};
use super::gh_pull_requests::SearchQualifierFlag;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSearchRepository {
    pub name_with_owner: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAcrossEntry {
    pub number: u64,
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    pub author: GhActor,
    pub updated_at: String,
    pub repository: GhSearchRepository,
}

const ACROSS_FIELDS: &str = "number,title,state,isDraft,author,updatedAt,repository";

#[derive(Deserialize)]
struct RateLimitResponse {
    resources: RateLimitResources,
}

#[derive(Deserialize)]
struct RateLimitResources {
    search: RateLimitBucket,
}

#[derive(Deserialize)]
struct RateLimitBucket {
    remaining: u64,
}

/// Refuses before searching when the search budget is spent. A failure of this probe is not an
/// error: the search itself reports `rate-limited` through `gh`'s own message if it truly is.
pub async fn ensure_search_budget(cwd: &Path) -> Result<(), GhError> {
    let Ok(limits) = gh_json::<RateLimitResponse>(cwd, &["api", "rate_limit"]).await else {
        return Ok(());
    };
    if limits.resources.search.remaining == 0 {
        return Err(GhError::new(
            GhErrorCode::RateLimited,
            "GitHub's search rate limit is used up. Try again in a minute.",
        ));
    }
    Ok(())
}

/// One `gh search prs` with a `--repo` per slug. Every flag is pushed before `--`; the free text
/// is the final argv entry after it, as in `search_pull_requests`.
pub async fn search_across(
    cwd: &Path,
    slugs: &[String],
    qualifier_flag: Option<SearchQualifierFlag>,
    state: Option<&str>,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<GhAcrossEntry>, GhError> {
    let limit_arg = limit.to_string();
    let mut args: Vec<&str> = vec!["search", "prs"];
    for slug in slugs {
        args.push("--repo");
        args.push(slug);
    }
    if let Some(flag) = qualifier_flag {
        args.push(flag.as_str());
        args.push("@me");
    }
    if let Some(state) = state {
        args.push("--state");
        args.push(state);
    }
    args.extend([
        "--sort",
        "updated",
        "--order",
        "desc",
        "--limit",
        &limit_arg,
        "--json",
        ACROSS_FIELDS,
    ]);
    if let Some(query) = query.filter(|q| !q.is_empty()) {
        args.push("--");
        args.push(query);
    }
    gh_json(cwd, &args).await
}
