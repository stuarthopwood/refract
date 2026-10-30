// Issues view surface: list issues and read one body. Same safety model as `gh_issues.rs`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gh::{gh_json, owner_repo_for, GhError, GhErrorCode};
use super::gh_issues::{clean_search_query, validate_labels, GhIssueLabel};

const LIST_LIMIT: &str = "50";
const LIST_FIELDS: &str = "number,title,state,url,labels,assignees,author,comments,updatedAt";
const VIEW_FIELDS: &str = "number,title,state,url,labels,assignees,author,body,createdAt,updatedAt";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueTab {
    All,
    Assigned,
    Authored,
    Mentions,
}

pub fn parse_tab(value: &str) -> Option<IssueTab> {
    match value {
        "all" => Some(IssueTab::All),
        "assigned" => Some(IssueTab::Assigned),
        "authored" => Some(IssueTab::Authored),
        "mentions" => Some(IssueTab::Mentions),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueStateFilter {
    Open,
    Closed,
    All,
}

pub fn parse_state(value: &str) -> Option<IssueStateFilter> {
    match value {
        "open" => Some(IssueStateFilter::Open),
        "closed" => Some(IssueStateFilter::Closed),
        "all" => Some(IssueStateFilter::All),
        _ => None,
    }
}

impl IssueStateFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

/// One validated list request. `label` and `search` are already cleaned.
#[derive(Debug, Clone)]
pub struct IssueListQuery {
    pub tab: IssueTab,
    pub state: IssueStateFilter,
    pub label: Option<String>,
    pub search: Option<String>,
}

impl IssueListQuery {
    pub fn new(
        tab: IssueTab,
        state: IssueStateFilter,
        label: Option<&str>,
        search: Option<&str>,
    ) -> Result<Self, GhError> {
        let label = match label.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => validate_labels(&[value.to_string()])?.into_iter().next(),
            None => None,
        };
        Ok(Self {
            tab,
            state,
            label,
            search: search.and_then(clean_search_query),
        })
    }
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssue {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    labels: Vec<GhIssueLabel>,
    #[serde(default)]
    assignees: Vec<RawUser>,
    #[serde(default)]
    author: Option<RawUser>,
    #[serde(default)]
    comments: Value,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

/// One row of the Issues list; the IPC handler fills `repository_id` and `repository_name`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRow {
    pub owner_repo: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub labels: Vec<GhIssueLabel>,
    pub assignees: Vec<String>,
    pub author: String,
    pub comment_count: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub owner_repo: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub labels: Vec<GhIssueLabel>,
    pub assignees: Vec<String>,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `gh issue list --json comments` is an array on some `gh` versions and `{ "totalCount": n }`
/// on others.
fn comment_count(value: &Value) -> u64 {
    match value {
        Value::Array(items) => items.len() as u64,
        Value::Object(map) => map.get("totalCount").and_then(Value::as_u64).unwrap_or(0),
        _ => 0,
    }
}

/// Only `https://github.com/<owner>/<repo>/issues/<n>` for the scoped repository is accepted, so
/// the renderer never opens an address GitHub text could have steered elsewhere.
pub fn issue_url_matches(url: &str, owner: &str, repo: &str, number: u64) -> bool {
    let expected = format!("https://github.com/{owner}/{repo}/issues/{number}");
    url.eq_ignore_ascii_case(&expected)
}

fn logins(users: Vec<RawUser>) -> Vec<String> {
    users
        .into_iter()
        .map(|user| user.login)
        .filter(|login| !login.is_empty())
        .collect()
}

fn argv_for_list(slug: &str, query: &IssueListQuery) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "issue".into(),
        "list".into(),
        "--repo".into(),
        slug.into(),
        "--state".into(),
        query.state.as_str().into(),
        "--limit".into(),
        LIST_LIMIT.into(),
        "--json".into(),
        LIST_FIELDS.into(),
    ];
    match query.tab {
        IssueTab::All => {}
        IssueTab::Assigned => args.push("--assignee=@me".into()),
        IssueTab::Authored => args.push("--author=@me".into()),
        IssueTab::Mentions => args.push("--mention=@me".into()),
    }
    if let Some(label) = &query.label {
        args.push(format!("--label={label}"));
    }
    if let Some(search) = &query.search {
        args.push(format!("--search={search}"));
    }
    args
}

pub async fn list_issues(
    repo_path: &Path,
    owner: &str,
    repo: &str,
    query: &IssueListQuery,
) -> Result<Vec<IssueRow>, GhError> {
    let slug = format!("{owner}/{repo}");
    let args = argv_for_list(&slug, query);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw: Vec<RawIssue> = gh_json(repo_path, &arg_refs).await?;
    Ok(raw
        .into_iter()
        .filter(|issue| issue_url_matches(&issue.url, owner, repo, issue.number))
        .map(|issue| IssueRow {
            owner_repo: slug.clone(),
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.url,
            labels: issue.labels,
            assignees: logins(issue.assignees),
            author: issue.author.map(|user| user.login).unwrap_or_default(),
            comment_count: comment_count(&issue.comments),
            updated_at: issue.updated_at,
        })
        .collect())
}

pub async fn view_issue(repo_path: &Path, number: u64) -> Result<IssueDetail, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let slug = format!("{owner}/{repo}");
    let number_arg = number.to_string();
    let raw: RawIssue = gh_json(
        repo_path,
        &[
            "issue",
            "view",
            &number_arg,
            "--repo",
            &slug,
            "--json",
            VIEW_FIELDS,
        ],
    )
    .await?;
    if !issue_url_matches(&raw.url, &owner, &repo, raw.number) {
        return Err(GhError::new(
            GhErrorCode::GithubFailed,
            "GitHub returned an issue that does not belong to this GitHub repository.",
        ));
    }
    Ok(IssueDetail {
        owner_repo: slug,
        number: raw.number,
        title: raw.title,
        state: raw.state,
        url: raw.url,
        labels: raw.labels,
        assignees: logins(raw.assignees),
        author: raw.author.map(|user| user.login).unwrap_or_default(),
        body: raw.body,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}
