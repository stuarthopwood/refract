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
fn merge_results(
    exact: Option<ItemSummary>,
    found: Vec<ItemSummary>,
) -> Vec<ItemSummary> {
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
    let mut args: Vec<String> = [
        "api",
        "--method",
        "GET",
        "search/issues",
        "-f",
    ]
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
            Some(path) => gh_json::<RawSearchItem>(cwd, &["api", path.as_str()]).await.ok(),
            None => None,
        }
    };
    let (page, exact) = tokio::join!(gh_json::<RawSearchPage>(cwd, &arg_refs), exact_future);
    let found = page?.items.into_iter().map(summarise).collect();
    Ok(merge_results(exact.map(summarise), found))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rejects_traversal_and_odd_characters() {
        assert!(RepoSlug::parse("owner", "repo.name-1_x").is_ok());
        assert!(RepoSlug::parse("..", "repo").is_err());
        assert!(RepoSlug::parse("owner", "re/po").is_err());
        assert!(RepoSlug::parse("", "repo").is_err());
        assert!(RepoSlug::parse("my-org", "a.b_c-d").is_ok());
        assert!(RepoSlug::parse("-owner", "repo").is_err());
        assert!(RepoSlug::parse("owner", "-repo").is_err());
        assert!(RepoSlug::parse("owner", "..").is_err());
        assert!(RepoSlug::parse("own er", "repo").is_err());
        assert!(RepoSlug::parse("owner", "re po").is_err());
        assert!(RepoSlug::parse("ow/ner", "repo").is_err());
    }

    #[test]
    fn reference_must_match_number_and_github_url() {
        assert!(reference_matches(
            12,
            "https://github.com/a/b/issues/12",
            12
        ));
        assert!(!reference_matches(
            13,
            "https://github.com/a/b/issues/12",
            12
        ));
        assert!(!reference_matches(
            12,
            "https://github.com/a/b/issues/13",
            12
        ));
        assert!(!reference_matches(
            12,
            "https://evil.example/a/b/issues/12",
            12
        ));
    }

    #[test]
    fn api_path_is_built_from_validated_parts() {
        let slug = RepoSlug::parse("a", "b").unwrap();
        assert_eq!(slug.api_path("pulls", 7), "repos/a/b/pulls/7");
        assert_eq!(slug.display(), "a/b");
    }

    #[test]
    fn merged_wins_over_closed() {
        assert_eq!(state_of("closed", true), ItemState::Merged);
        assert_eq!(state_of("closed", false), ItemState::Closed);
        assert_eq!(state_of("open", false), ItemState::Open);
    }

    #[test]
    fn item_number_is_bounded() {
        assert!(!valid_item_number(0));
        assert!(valid_item_number(1));
        assert!(valid_item_number(i32::MAX as u64));
        assert!(!valid_item_number(i32::MAX as u64 + 1));
    }

    #[test]
    fn item_url_must_be_github_and_end_with_the_number() {
        assert!(is_github_item_url("https://github.com/a/b/pull/12", 12));
        assert!(!is_github_item_url("https://evil.example/a/b/pull/12", 12));
        assert!(!is_github_item_url("https://github.com/a/b/pull/123", 12));
    }

    #[test]
    fn raw_item_parses_a_pull_request_payload() {
        let raw: RawItem = serde_json::from_str(
            r#"{"number":3,"title":"t","state":"open","html_url":"https://github.com/a/b/pull/3",
                "created_at":"2026-01-01T00:00:00Z","user":{"login":"u","avatar_url":null},
                "pull_request":{"url":"x"}}"#,
        )
        .unwrap();
        assert!(raw.pull_request.is_some());
        assert_eq!(raw.user.unwrap().login, "u");
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn slug() -> RepoSlug {
        RepoSlug::parse("a", "b").unwrap()
    }

    fn row(number: u64) -> ItemSummary {
        ItemSummary {
            number,
            kind: ItemKind::Issue,
            title: format!("t{number}"),
            state: ItemState::Open,
            draft: false,
        }
    }

    #[test]
    fn query_is_one_plain_lowercase_term() {
        assert_eq!(sanitize_query("Login"), "login");
        assert_eq!(sanitize_query("fix login"), "fix");
        assert_eq!(sanitize_query("repo:other/x"), "repootherx");
        assert_eq!(sanitize_query("-label:bug"), "labelbug");
        assert_eq!(sanitize_query("\"quoted\""), "quoted");
        assert_eq!(sanitize_query("AND"), "and");
        assert_eq!(sanitize_query(""), "");
        assert_eq!(sanitize_query("   "), "");
    }

    #[test]
    fn query_length_is_bounded() {
        assert_eq!(sanitize_query(&"a".repeat(500)).len(), MAX_QUERY_CHARS);
    }

    #[test]
    fn search_is_always_scoped_to_the_repository() {
        assert_eq!(search_query(&slug(), ""), "repo:a/b is:open");
        assert_eq!(search_query(&slug(), "login"), "repo:a/b in:title login");
        // Whatever was typed, the only qualifier colon pair left is the repo one.
        let hostile = search_query(&slug(), &sanitize_query("repo:evil/x is:closed"));
        assert_eq!(hostile.matches(':').count(), 2);
        assert!(hostile.starts_with("repo:a/b "));
    }

    #[test]
    fn search_page_parses_issues_and_pull_requests() {
        let page: RawSearchPage = serde_json::from_str(
            r#"{"total_count":3,"items":[
            {"number":1,"title":"an issue","state":"open","draft":null},
            {"number":2,"title":"a draft","state":"open","draft":true,"pull_request":{"merged_at":null}},
            {"number":3,"title":"merged","state":"closed","draft":false,"pull_request":{"merged_at":"2026-01-01T00:00:00Z"}}]}"#,
        )
        .unwrap();
        let rows: Vec<ItemSummary> = page.items.into_iter().map(summarise).collect();
        assert_eq!(rows[0].kind, ItemKind::Issue);
        assert!(!rows[0].draft);
        assert_eq!(rows[1].kind, ItemKind::PullRequest);
        assert!(rows[1].draft);
        assert_eq!(rows[2].state, ItemState::Merged);
    }

    #[test]
    fn exact_match_is_pinned_first_without_duplicates_and_capped() {
        let found: Vec<ItemSummary> = (1..=12).map(row).collect();
        let rows = merge_results(Some(row(5)), found);
        assert_eq!(rows.len(), MAX_SEARCH_RESULTS);
        assert_eq!(rows[0].number, 5);
        assert_eq!(rows.iter().filter(|r| r.number == 5).count(), 1);
        assert!(merge_results(None, Vec::new()).is_empty());
    }

    #[test]
    fn merge_keeps_full_order_with_exact_first() {
        let found: Vec<ItemSummary> = (1..=12).map(row).collect();
        let numbers: Vec<u64> = merge_results(Some(row(5)), found)
            .iter()
            .map(|r| r.number)
            .collect();
        assert_eq!(numbers, vec![5, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn merge_pins_an_exact_item_the_search_did_not_find() {
        let found: Vec<ItemSummary> = (1..=12).map(row).collect();
        let numbers: Vec<u64> = merge_results(Some(row(50)), found)
            .iter()
            .map(|r| r.number)
            .collect();
        assert_eq!(numbers, vec![50, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn merge_prefers_the_pinned_rows_data_over_the_search_copy() {
        let mut pinned = row(5);
        pinned.title = "pinned".to_string();
        let rows = merge_results(Some(pinned), (1..=6).map(row).collect());
        assert_eq!(rows[0].title, "pinned");
        assert_eq!(rows.iter().filter(|r| r.number == 5).count(), 1);
        assert!(merge_results(None, Vec::new()).is_empty());
    }

    #[test]
    fn sanitize_keeps_title_characters_and_drops_hostile_ones() {
        assert_eq!(sanitize_query("fix-login.v2_x"), "fix-login.v2_x");
        assert_eq!(sanitize_query("  repo:evil/x"), "repoevilx");
        assert_eq!(sanitize_query("--x"), "x");
        assert_eq!(sanitize_query("---"), "");
        assert_eq!(sanitize_query("héllo"), "hllo");
        assert_eq!(sanitize_query("日本"), "");
    }

    #[test]
    fn sanitize_cut_may_end_on_a_hyphen() {
        let text = format!("{}-bcd", "a".repeat(MAX_QUERY_CHARS - 1));
        let term = sanitize_query(&text);
        assert_eq!(term.len(), MAX_QUERY_CHARS);
        assert!(term.ends_with('-'));
    }

    #[test]
    fn search_args_for_an_empty_term_sort_by_recent_update() {
        assert_eq!(
            search_args(&slug(), ""),
            [
                "api", "--method", "GET", "search/issues", "-f", "q=repo:a/b is:open", "-f",
                "per_page=10", "-f", "sort=updated", "-f", "order=desc"
            ]
        );
    }

    #[test]
    fn search_args_for_a_term_have_no_sort_or_order() {
        assert_eq!(
            search_args(&slug(), "login"),
            [
                "api", "--method", "GET", "search/issues", "-f", "q=repo:a/b in:title login",
                "-f", "per_page=10"
            ]
        );
    }

    #[test]
    fn exact_number_accepts_only_real_item_numbers() {
        assert_eq!(exact_number("0"), None);
        assert_eq!(exact_number("007"), Some(7));
        assert_eq!(exact_number("12abc"), None);
        assert_eq!(exact_number("1.5"), None);
        assert_eq!(exact_number("99999999999999999999999"), None);
        assert_eq!(exact_number("2147483647"), Some(i32::MAX as u64));
        assert_eq!(exact_number("2147483648"), None);
    }

    #[test]
    fn closed_unmerged_pull_request_is_closed_not_merged() {
        let page: RawSearchPage = serde_json::from_str(
            r#"{"items":[{"number":4,"title":"x","state":"closed","draft":false,"pull_request":{"merged_at":null}}]}"#,
        )
        .unwrap();
        let row = summarise(page.items.into_iter().next().unwrap());
        assert_eq!(row.kind, ItemKind::PullRequest);
        assert_eq!(row.state, ItemState::Closed);
    }

    #[test]
    fn item_summary_serialises_camel_case_with_kebab_kind() {
        let summary = ItemSummary {
            number: 7,
            kind: ItemKind::PullRequest,
            title: "t".to_string(),
            state: ItemState::Open,
            draft: true,
        };
        assert_eq!(
            serde_json::to_value(summary).unwrap(),
            serde_json::json!({
                "number": 7, "kind": "pull-request", "title": "t", "state": "open", "draft": true
            })
        );
    }
}
