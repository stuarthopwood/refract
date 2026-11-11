// Item card lookup for `#123` / `owner/repo#123` references (#1155). One bounded `gh api` call per
// issue or pull request; a pull request adds one more for its branches. `search_items` (#1789)
// backs the composer `#` picker: one bounded search of a single repository, plus an exact-number
// lookup when the query is digits, because GitHub's search cannot match a number prefix.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::gh::{gh_json, is_valid_owner_or_repo_segment, GhError, GhErrorCode};
use super::profile::fetch_avatar;

/// GitHub numbers fit GraphQL's 32-bit `Int`; a larger value is never a real item.
const MAX_ITEM_NUMBER: u64 = i32::MAX as u64;

/// A validated `owner/repo`, so only GitHub's own name characters reach a `gh api` path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSlug {
    owner: String,
    repo: String,
}

impl RepoSlug {
    pub fn parse(owner: &str, repo: &str) -> Result<Self, GhError> {
        // A leading `-` could be read as an option by anything downstream; GitHub names never need it.
        let bad = |s: &str| !is_valid_owner_or_repo_segment(s) || s.starts_with('-');
        if bad(owner) || bad(repo) {
            return Err(GhError::new(
                GhErrorCode::GithubFailed,
                "That is not a valid GitHub repository name.",
            ));
        }
        Ok(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }

    fn api_path(&self, collection: &str, number: u64) -> String {
        format!("repos/{}/{}/{collection}/{number}", self.owner, self.repo)
    }

    fn display(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    Issue,
    PullRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCard {
    pub owner_repo: String,
    pub number: u64,
    pub kind: ItemKind,
    pub title: String,
    pub state: ItemState,
    pub draft: bool,
    pub url: String,
    pub created_at: String,
    pub author_login: String,
    /// A validated `data:` URL: the CSP only allows `'self' data:` images.
    pub avatar_data_url: Option<String>,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct RawItem {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    created_at: String,
    user: Option<RawUser>,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawBranch {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Deserialize)]
struct RawPull {
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    draft: bool,
    base: RawBranch,
    head: RawBranch,
}

fn state_of(raw_state: &str, merged: bool) -> ItemState {
    if merged {
        ItemState::Merged
    } else if raw_state == "open" {
        ItemState::Open
    } else {
        ItemState::Closed
    }
}

/// GitHub redirects a renamed repository, so the URL is only required to be an item URL on github.com.
fn is_github_item_url(url: &str, number: u64) -> bool {
    url.strip_prefix("https://github.com/")
        .is_some_and(|rest| rest.ends_with(&format!("/{number}")))
}

/// Whether GitHub's answer is the item that was asked for (renames redirect, so the repo name is not compared).
fn reference_matches(returned_number: u64, html_url: &str, number: u64) -> bool {
    returned_number == number && is_github_item_url(html_url, number)
}

pub fn valid_item_number(number: u64) -> bool {
    number > 0 && number <= MAX_ITEM_NUMBER
}

/// Looks one item up. `cwd` is any local clone (the Session's Project) so `gh` has its usual auth
/// context; the repository queried is `slug`, which may differ from it.
pub async fn lookup_item(cwd: &Path, slug: &RepoSlug, number: u64) -> Result<ItemCard, GhError> {
    if !valid_item_number(number) {
        return Err(GhError::new(
            GhErrorCode::GithubFailed,
            "That is not a valid issue or pull request number.",
        ));
    }
    // The issues endpoint answers for both kinds; `pull_request` marks which one it was.
    let issue_path = slug.api_path("issues", number);
    let raw: RawItem = gh_json(cwd, &["api", &issue_path]).await?;
    if !reference_matches(raw.number, &raw.html_url, number) {
        return Err(GhError::new(
            GhErrorCode::GithubFailed,
            "GitHub returned an item that does not match the reference.",
        ));
    }
    let pull: Option<RawPull> = if raw.pull_request.is_some() {
        let pull_path = slug.api_path("pulls", number);
        Some(gh_json(cwd, &["api", &pull_path]).await?)
    } else {
        None
    };
    let (author_login, avatar_url) = match raw.user {
        Some(user) => (user.login, user.avatar_url),
        None => (String::new(), None),
    };
    let avatar_data_url = match avatar_url {
        Some(url) => fetch_avatar(&url).await.ok(),
        None => None,
    };
    Ok(ItemCard {
        owner_repo: slug.display(),
        number,
        kind: if pull.is_some() {
            ItemKind::PullRequest
        } else {
            ItemKind::Issue
        },
        title: raw.title,
        state: state_of(&raw.state, pull.as_ref().is_some_and(|p| p.merged)),
        draft: pull.as_ref().is_some_and(|p| p.draft),
        url: raw.html_url,
        created_at: raw.created_at,
        author_login,
        avatar_data_url,
        base_ref: pull.as_ref().map(|p| p.base.name.clone()),
        head_ref: pull.map(|p| p.head.name),
    })
}

/// The picker lists at most this many rows (grill outcome: top 10, no paging).
pub const MAX_SEARCH_RESULTS: usize = 10;
/// Longer than any title word worth typing; bounds what reaches `gh`.
const MAX_QUERY_CHARS: usize = 64;

/// One picker row: just enough to choose an item and insert `#<number> `.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub number: u64,
    pub kind: ItemKind,
    pub title: String,
    pub state: ItemState,
    pub draft: bool,
}

#[derive(Deserialize)]
struct RawMergeMarker {
    merged_at: Option<String>,
}

/// Shared by `search/issues` rows and the single `issues/<n>` payload; both carry `pull_request.merged_at`.
#[derive(Deserialize)]
struct RawSearchItem {
    number: u64,
    title: String,
    state: String,
    draft: Option<bool>,
    pull_request: Option<RawMergeMarker>,
}

#[derive(Deserialize)]
struct RawSearchPage {
    items: Vec<RawSearchItem>,
}

/// Reduces typed text to one plain term. Anything that could be a search qualifier, operator or a
/// second repository (`repo:`, `is:`, `-term`, quotes, spaces) is dropped, so the search can only
/// ever look at `slug`.
fn sanitize_query(text: &str) -> String {
    let word = text.split_whitespace().next().unwrap_or("");
    let kept: String = word
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(MAX_QUERY_CHARS)
        .collect();
    // A leading `-` negates a term, and lower case keeps `AND`/`OR`/`NOT` from acting as operators.
    kept.trim_start_matches('-').to_ascii_lowercase()
}

/// The `q` for `search/issues`: titles of open and closed items for a term, open items otherwise.
fn search_query(slug: &RepoSlug, term: &str) -> String {
    if term.is_empty() {
        format!("repo:{} is:open", slug.display())
    } else {
        format!("repo:{} in:title {term}", slug.display())
    }
}

fn summarise(raw: RawSearchItem) -> ItemSummary {
    let merged = raw
        .pull_request
        .as_ref()
        .is_some_and(|p| p.merged_at.is_some());
    ItemSummary {
        number: raw.number,
        kind: if raw.pull_request.is_some() {
            ItemKind::PullRequest
        } else {
            ItemKind::Issue
        },
        title: raw.title,
        state: state_of(&raw.state, merged),
        draft: raw.draft.unwrap_or(false),
    }
}

/// Puts the exact-number match first, drops its duplicate from the search rows, and caps the list.
fn merge_results(exact: Option<ItemSummary>, found: Vec<ItemSummary>) -> Vec<ItemSummary> {
    let mut rows: Vec<ItemSummary> = Vec::with_capacity(MAX_SEARCH_RESULTS);
    if let Some(item) = exact {
        rows.push(item);
    }
    for item in found {
        if rows.iter().all(|row| row.number != item.number) {
            rows.push(item);
        }
    }
    rows.truncate(MAX_SEARCH_RESULTS);
    rows
}

/// `gh api` arguments for one search; only an empty term asks for the most recently updated open items.
fn search_args(slug: &RepoSlug, term: &str) -> Vec<String> {
    let mut args: Vec<String> = ["api", "--method", "GET", "search/issues", "-f"]
        .map(String::from)
        .into();
    args.push(format!("q={}", search_query(slug, term)));
    args.push("-f".to_string());
    args.push(format!("per_page={MAX_SEARCH_RESULTS}"));
    if term.is_empty() {
        args.extend(["-f", "sort=updated", "-f", "order=desc"].map(String::from));
    }
    args
}

/// A digits-only term names an item directly; GitHub's search cannot match a number prefix.
fn exact_number(term: &str) -> Option<u64> {
    term.parse::<u64>().ok().filter(|&n| valid_item_number(n))
}

/// Searches issues and pull requests of `slug` only. `cwd` is any local clone, for `gh`'s auth context.
pub async fn search_items(
    cwd: &Path,
    slug: &RepoSlug,
    text: &str,
) -> Result<Vec<ItemSummary>, GhError> {
    let term = sanitize_query(text);
    let args = search_args(slug, &term);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // The exact item is best effort: a number that is not an item (404) just means no pinned row.
    let exact_path = exact_number(&term).map(|n| slug.api_path("issues", n));
    let exact_future = async {
        match &exact_path {
            Some(path) => gh_json::<RawSearchItem>(cwd, &["api", path.as_str()])
                .await
                .ok(),
            None => None,
        }
    };
    let (page, exact) = tokio::join!(gh_json::<RawSearchPage>(cwd, &arg_refs), exact_future);
    let found = page?.items.into_iter().map(summarise).collect();
    Ok(merge_results(exact.map(summarise), found))
}

#[cfg(test)]
#[path = "item_ref_tests.rs"]
mod tests;
