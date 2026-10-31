// Read-only GraphQL lookup of the PR for a Session's branch, with checks and closing issues.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::github::gh::{gh_graphql, owner_repo_for, GraphqlValue};

/// Issue titles are untrusted text; the cap keeps the readout payload small.
const TITLE_MAX_CHARS: usize = 200;

/// The URL is not rendered; the cap and the https check keep a hostile value out of the payload.
const URL_MAX_CHARS: usize = 2048;

/// A failed lookup is not retried for this long, so a broken `gh` is not spawned on every poll.
const UNAVAILABLE_BACKOFF: Duration = Duration::from_secs(60);

static UNAVAILABLE_UNTIL: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

fn backed_off(key: &(String, String)) -> bool {
    let mut guard = UNAVAILABLE_UNTIL.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    match map.get(key) {
        Some(until) if *until > Instant::now() => true,
        Some(_) => {
            map.remove(key);
            false
        }
        None => false,
    }
}

fn back_off(key: (String, String)) {
    let mut guard = UNAVAILABLE_UNTIL.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    map.retain(|_, until| *until > now);
    map.insert(key, now + UNAVAILABLE_BACKOFF);
}

const QUERY: &str = "query($owner: String!, $name: String!, $branch: String!) { \
repository(owner: $owner, name: $name) { \
pullRequests(headRefName: $branch, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) { \
nodes { number url state isDraft \
commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } \
closingIssuesReferences(first: 10) { nodes { number state title } } } } } }";

#[derive(Debug, Clone)]
pub(super) struct LinkedIssueState {
    number: u64,
    state: &'static str,
    title: String,
}

#[derive(Debug, Clone)]
pub(super) struct PullRequestState {
    number: u64,
    url: String,
    state: &'static str,
    checks: Option<&'static str>,
    linked_issues: Vec<LinkedIssueState>,
}

impl PullRequestState {
    pub(super) fn to_json(&self) -> Value {
        let issues: Vec<Value> = self
            .linked_issues
            .iter()
            .map(|i| json!({ "number": i.number, "state": i.state, "title": i.title }))
            .collect();
        json!({
            "number": self.number,
            "url": self.url,
            "state": self.state,
            "checks": self.checks,
            "linkedIssues": issues,
        })
    }
}

pub(super) enum PullRequestLookup {
    Found(PullRequestState),
    None,
    Unavailable,
}

#[derive(Deserialize)]
struct Data {
    repository: Option<Repository>,
}

#[derive(Deserialize)]
struct Repository {
    #[serde(rename = "pullRequests")]
    pull_requests: Nodes<PrNode>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
struct PrNode {
    number: u64,
    url: String,
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    commits: Nodes<CommitNode>,
    #[serde(rename = "closingIssuesReferences")]
    closing_issues: Nodes<IssueNode>,
}

#[derive(Deserialize)]
struct CommitNode {
    commit: Commit,
}

#[derive(Deserialize)]
struct Commit {
    #[serde(rename = "statusCheckRollup")]
    rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}

#[derive(Deserialize)]
struct IssueNode {
    number: u64,
    state: String,
    title: String,
}

fn pr_state(node: &PrNode) -> &'static str {
    match node.state.as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ if node.is_draft => "draft",
        _ => "open",
    }
}

fn checks_state(node: &PrNode) -> Option<&'static str> {
    let rollup = node
        .commits
        .nodes
        .iter()
        .flatten()
        .next()?
        .commit
        .rollup
        .as_ref()?;
    match rollup.state.as_str() {
        "SUCCESS" => Some("pass"),
        "FAILURE" | "ERROR" => Some("fail"),
        "PENDING" | "EXPECTED" => Some("pending"),
        _ => None,
    }
}

fn issue_state(state: &str) -> &'static str {
    match state {
        "CLOSED" => "closed",
        "OPEN" => "open",
        _ => "unknown",
    }
}

fn valid_url(url: &str) -> bool {
    url.len() <= URL_MAX_CHARS && url.starts_with("https://")
}

fn to_state(node: &PrNode) -> Option<PullRequestState> {
    if !valid_url(&node.url) {
        return None;
    }
    let linked_issues = node
        .closing_issues
        .nodes
        .iter()
        .flatten()
        .map(|i| LinkedIssueState {
            number: i.number,
            state: issue_state(&i.state),
            title: i.title.chars().take(TITLE_MAX_CHARS).collect(),
        })
        .collect();
    Some(PullRequestState {
        number: node.number,
        url: node.url.clone(),
        state: pr_state(node),
        checks: checks_state(node),
        linked_issues,
    })
}

/// The open PR for `branch`, else the most recently updated one; every error is `Unavailable`.
pub(super) async fn pull_request_for_branch(repo_path: &Path, branch: &str) -> PullRequestLookup {
    let key = (repo_path.to_string_lossy().into_owned(), branch.to_string());
    if backed_off(&key) {
        return PullRequestLookup::Unavailable;
    }
    let lookup = lookup_uncached(repo_path, branch).await;
    if matches!(lookup, PullRequestLookup::Unavailable) {
        back_off(key);
    }
    lookup
}

/// Redacted, length-capped gh error text, safe to log.
fn log_detail(message: &str) -> String {
    let redacted = crate::omp::redact::redact_secrets(message);
    redacted.chars().take(300).collect()
}

async fn lookup_uncached(repo_path: &Path, branch: &str) -> PullRequestLookup {
    let (owner, name) = match owner_repo_for(repo_path).await {
        Ok(pair) => pair,
        Err(err) => {
            log::warn!(
                "readout PR lookup: {}: {}",
                err.code.as_str(),
                log_detail(&err.message)
            );
            return PullRequestLookup::Unavailable;
        }
    };
    let data: Data = match gh_graphql(
        repo_path,
        QUERY,
        &[
            ("owner", GraphqlValue::Str(&owner)),
            ("name", GraphqlValue::Str(&name)),
            ("branch", GraphqlValue::Str(branch)),
        ],
    )
    .await
    {
        Ok(data) => data,
        Err(err) => {
            log::warn!(
                "readout PR lookup: {}: {}",
                err.code.as_str(),
                log_detail(&err.message)
            );
            return PullRequestLookup::Unavailable;
        }
    };
    let Some(repository) = data.repository else {
        return PullRequestLookup::Unavailable;
    };
    let nodes: Vec<&PrNode> = repository.pull_requests.nodes.iter().flatten().collect();
    let chosen = nodes
        .iter()
        .find(|n| n.state == "OPEN")
        .or_else(|| nodes.first());
    match chosen {
        Some(node) => match to_state(node) {
            Some(state) => PullRequestLookup::Found(state),
            None => {
                log::warn!("readout PR lookup: PR #{} has an unusable url", node.number);
                PullRequestLookup::Unavailable
            }
        },
        None => PullRequestLookup::None,
    }
}
