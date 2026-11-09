// Item card lookup for `#123` / `owner/repo#123` references (#1155). One bounded `gh api` call per
// issue or pull request; a pull request adds one more for its branches. A search by number or
// text (#1789) is another `pub async fn` beside `lookup_item`, reusing `RepoSlug` and `ItemCard`.

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
        if !is_valid_owner_or_repo_segment(owner) || !is_valid_owner_or_repo_segment(repo) {
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
        format!(
            "repos/{}/{}/{collection}/{number}",
            self.owner, self.repo
        )
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
    if raw.number != number || !is_github_item_url(&raw.html_url, number) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rejects_traversal_and_odd_characters() {
        assert!(RepoSlug::parse("owner", "repo.name-1_x").is_ok());
        assert!(RepoSlug::parse("..", "repo").is_err());
        assert!(RepoSlug::parse("owner", "re/po").is_err());
        assert!(RepoSlug::parse("", "repo").is_err());
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
