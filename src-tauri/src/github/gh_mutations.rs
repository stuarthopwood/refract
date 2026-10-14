// Port of `src/main/github/gh.ts`'s review-thread/timeline/comment/review/merge surface (lane
// R9, issue #792), split out of `gh.rs` to stay under the 600-line-per-file cap (issue #806): the
// core timed `gh` wrapper (`gh_raw`/`gh_json`/`gh_graphql`/`owner_repo_for`) lives in `gh.rs`; the
// list/search/view/staleness/files surface lives in `gh_pull_requests.rs`.

use std::path::Path;

use serde::Deserialize;

use super::gh::{
    gh_graphql, gh_json, gh_raw, map_gh_failure, non_empty_or, owner_repo_for, GhActor, GhError,
    GhErrorCode, GraphqlValue,
};

/// `reviewThreads`/`timelineItems`: connection shapes confirmed live via introspection plus a
/// live query. `item_types` filters the timeline to the three kinds this feature renders.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReviewThreadComment {
    pub id: String,
    pub author: Option<GhActor>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhReviewThreadComments {
    pub nodes: Vec<GhReviewThreadComment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReviewThreadNode {
    pub id: String,
    pub is_resolved: bool,
    #[serde(default)]
    pub is_outdated: bool,
    pub path: String,
    pub line: Option<i64>,
    pub diff_side: String,
    pub comments: GhReviewThreadComments,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhTimelineCommitAuthor {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTimelineCommit {
    pub oid: String,
    pub message: String,
    pub committed_date: String,
    #[serde(default)]
    pub author: Option<GhTimelineCommitAuthor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTimelineNode {
    #[serde(rename = "__typename")]
    pub __typename: String,
    #[serde(default)]
    pub commit: Option<GhTimelineCommit>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub author: Option<GhActor>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReviewThreadsAndTimelineInner {
    pub id: String,
    pub review_threads: GhReviewThreadsNodes,
    pub timeline_items: GhTimelineNodes,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhReviewThreadsNodes {
    pub nodes: Vec<GhReviewThreadNode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhTimelineNodes {
    pub nodes: Vec<GhTimelineNode>,
}

pub type GhThreadsAndTimeline = GhReviewThreadsAndTimelineInner;

const THREADS_AND_TIMELINE_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id reviewThreads(first: 50) { nodes { id isResolved isOutdated path line diffSide comments(first: 50) { nodes { id author { login ... on User { name } } body createdAt } } } } timelineItems(first: 100, itemTypes: [PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW]) { nodes { __typename ... on PullRequestCommit { commit { oid message committedDate author { name } } } ... on IssueComment { id author { login ... on User { name } } body createdAt } ... on PullRequestReview { id author { login ... on User { name } } state body submittedAt } } } } } }";

#[derive(Deserialize)]
struct ThreadsAndTimelineRepo {
    #[serde(rename = "pullRequest")]
    pull_request: GhThreadsAndTimeline,
}

#[derive(Deserialize)]
struct ThreadsAndTimelineData {
    repository: ThreadsAndTimelineRepo,
}

pub async fn get_review_threads_and_timeline(
    repo_path: &Path,
    number: u64,
) -> Result<GhThreadsAndTimeline, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let data: ThreadsAndTimelineData = gh_graphql(
        repo_path,
        THREADS_AND_TIMELINE_QUERY,
        &[
            ("owner", GraphqlValue::Str(&owner)),
            ("name", GraphqlValue::Str(&repo)),
            ("number", GraphqlValue::Int(number as i64)),
        ],
    )
    .await?;
    Ok(data.repository.pull_request)
}

/// Input shapes confirmed via introspection only; never executed live in this session. Variables,
/// never string interpolation, so a thread id never needs hand-escaping.
pub async fn resolve_review_thread_mutation(
    repo_path: &Path,
    thread_id: &str,
) -> Result<(), GhError> {
    let query = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
    let _: serde_json::Value =
        gh_graphql(repo_path, query, &[("id", GraphqlValue::Str(thread_id))]).await?;
    Ok(())
}

pub async fn unresolve_review_thread_mutation(
    repo_path: &Path,
    thread_id: &str,
) -> Result<(), GhError> {
    let query = "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
    let _: serde_json::Value =
        gh_graphql(repo_path, query, &[("id", GraphqlValue::Str(thread_id))]).await?;
    Ok(())
}

#[derive(Deserialize)]
struct ReplyCommentId {
    id: String,
}

#[derive(Deserialize)]
struct ReplyToThreadData {
    #[serde(rename = "addPullRequestReviewComment")]
    add_pull_request_review_comment: ReplyComment,
}

#[derive(Deserialize)]
struct ReplyComment {
    comment: ReplyCommentId,
}

/// `addPullRequestReviewComment(input: { inReplyTo: ... })`: `inReplyTo` confirmed as a real,
/// current input field. Links the reply to the thread's opening comment, never a new unrelated
/// top-level comment.
pub async fn reply_to_thread_mutation(
    repo_path: &Path,
    pull_request_id: &str,
    in_reply_to_comment_id: &str,
    body: &str,
) -> Result<String, GhError> {
    let query = "mutation($pr: ID!, $reply: ID!, $body: String!) { addPullRequestReviewComment(input: { pullRequestId: $pr, inReplyTo: $reply, body: $body }) { comment { id } } }";
    let data: ReplyToThreadData = gh_graphql(
        repo_path,
        query,
        &[
            ("pr", GraphqlValue::Str(pull_request_id)),
            ("reply", GraphqlValue::Str(in_reply_to_comment_id)),
            ("body", GraphqlValue::Str(body)),
        ],
    )
    .await?;
    Ok(data.add_pull_request_review_comment.comment.id)
}

/// A top-level pull request comment, distinct from a thread reply: the documented porcelain
/// `gh pr comment` command already covers it, no GraphQL mutation needed.
pub async fn comment_on_pull_request(
    repo_path: &Path,
    number: u64,
    body: &str,
) -> Result<(), GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let number_str = number.to_string();
    let result = gh_raw(
        repo_path,
        &[
            "pr",
            "comment",
            &number_str,
            "--repo",
            &format!("{owner}/{repo}"),
            "--body",
            body,
        ],
        None,
    )
    .await?;
    if result.code != 0 {
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewVerdict {
    Comment,
    Approve,
    RequestChanges,
}

/// `submit_review`'s approve-pin input: the cached `pullRequestId`/`headSha` `submitReview`'s
/// approve path pins its mutation to (security remediation, Medium-but-must-fix): approve must
/// never act on a head that moved since the renderer last saw it.
pub struct PinnedReview<'a> {
    pub pull_request_id: &'a str,
    pub head_sha: &'a str,
}

const ADD_REVIEW_MUTATION: &str = "mutation($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!, $body: String) { addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event, body: $body }) { clientMutationId } }";

/// `gh pr review`: documented porcelain command for comment/request-changes. Approve is pinned to
/// the exact reviewed commit via the `addPullRequestReview` GraphQL mutation's `commitOID` --
/// that field only RECORDS which commit the review is attached to display-side; the mutation
/// succeeds even if the head has since moved, so the IPC handler's own `expectedHeadSha` check
/// run immediately before this call is the real staleness guarantee, not anything this mutation
/// enforces.
pub async fn submit_review(
    repo_path: &Path,
    number: u64,
    verdict: ReviewVerdict,
    body: Option<&str>,
    pinned: Option<PinnedReview<'_>>,
) -> Result<(), GhError> {
    if verdict == ReviewVerdict::Approve {
        if let Some(pinned) = pinned {
            let variables = build_approve_review_variables(&pinned, body);
            let _: serde_json::Value =
                gh_graphql(repo_path, ADD_REVIEW_MUTATION, &variables).await?;
            return Ok(());
        }
    }
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let owner_repo = format!("{owner}/{repo}");
    let owned_args = build_review_argv(number, &owner_repo, verdict, body);
    let args: Vec<&str> = owned_args.iter().map(String::as_str).collect();
    let result = gh_raw(repo_path, &args, None).await?;
    if result.code != 0 {
        return Err(map_gh_failure(&result.stderr, &result.stdout));
    }
    Ok(())
}

/// `addPullRequestReview`'s GraphQL variables for the pinned-commit approve path, pulled out of
/// `submit_review` so the variable-building logic is testable without a live `gh` spawn.
fn build_approve_review_variables<'a>(
    pinned: &PinnedReview<'a>,
    body: Option<&'a str>,
) -> Vec<(&'a str, GraphqlValue<'a>)> {
    let mut variables = vec![
        ("pullRequestId", GraphqlValue::Str(pinned.pull_request_id)),
        ("commitOID", GraphqlValue::Str(pinned.head_sha)),
        ("event", GraphqlValue::Str("APPROVE")),
    ];
    if let Some(body) = body {
        variables.push(("body", GraphqlValue::Str(body)));
    }
    variables
}

/// `gh pr review`'s porcelain argv for the comment/request-changes path, pulled out of
/// `submit_review` so the argv shape is testable without a live `gh` spawn. Owned `Vec<String>`,
/// the same convention `gh_graphql`'s own `owned_args` already uses, since the args borrow from
/// locals (`number`'s string form, `owner_repo`) that don't outlive this function otherwise.
fn build_review_argv(
    number: u64,
    owner_repo: &str,
    verdict: ReviewVerdict,
    body: Option<&str>,
) -> Vec<String> {
    let flag = match verdict {
        ReviewVerdict::Approve => "--approve",
        ReviewVerdict::RequestChanges => "--request-changes",
        ReviewVerdict::Comment => "--comment",
    };
    let mut args = vec![
        "pr".to_string(),
        "review".to_string(),
        number.to_string(),
        "--repo".to_string(),
        owner_repo.to_string(),
        flag.to_string(),
    ];
    if let Some(body) = body {
        args.push("--body".to_string());
        args.push(body.to_string());
    }
    args
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "squash" => Some(Self::Squash),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Squash => "squash",
            Self::Rebase => "rebase",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllowedMergeMethodsWire {
    merge_commit_allowed: bool,
    squash_merge_allowed: bool,
    rebase_merge_allowed: bool,
}

/// Repository-level merge-method settings (`gh repo view --json`, a standard documented field
/// set): maps to the `MergeMethod[]` a pull request's `allowedMergeMethods` offers.
pub async fn get_allowed_merge_methods(repo_path: &Path) -> Result<Vec<MergeMethod>, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let result: AllowedMergeMethodsWire = gh_json(
        repo_path,
        &[
            "repo",
            "view",
            &format!("{owner}/{repo}"),
            "--json",
            "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
        ],
    )
    .await?;
    Ok(allowed_merge_methods_from_wire(&result))
}

/// The wire-booleans -> `Vec<MergeMethod>` mapping, pulled out of `get_allowed_merge_methods` so
/// every boolean combination is testable without a live `gh` spawn. Order always
/// merge/squash/rebase, matching the original `if`/`if`/`if` sequence.
fn allowed_merge_methods_from_wire(wire: &AllowedMergeMethodsWire) -> Vec<MergeMethod> {
    let mut methods = Vec::new();
    if wire.merge_commit_allowed {
        methods.push(MergeMethod::Merge);
    }
    if wire.squash_merge_allowed {
        methods.push(MergeMethod::Squash);
    }
    if wire.rebase_merge_allowed {
        methods.push(MergeMethod::Rebase);
    }
    methods
}

/// `head_sha` is always passed (security remediation, Medium-but-must-fix): `--match-head-commit`
/// makes GitHub itself refuse the merge if the pull request's head has moved since the renderer
/// last saw it, independent of (and a stronger guarantee than) the in-process staleness cache.
pub async fn merge_pull_request(
    repo_path: &Path,
    number: u64,
    method: MergeMethod,
    head_sha: &str,
) -> Result<(), GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let owner_repo = format!("{owner}/{repo}");
    let owned_args = build_merge_argv(number, &owner_repo, method, head_sha);
    let args: Vec<&str> = owned_args.iter().map(String::as_str).collect();
    let result = gh_raw(repo_path, &args, None).await?;
    if result.code != 0 {
        return Err(classify_merge_failure(&result.stderr, &result.stdout));
    }
    Ok(())
}

/// `gh pr merge`'s porcelain argv, pulled out of `merge_pull_request` so the
/// `--match-head-commit <sha>` shape (security-critical: confirmed present per a prior gate's
/// security review) is testable without a live `gh` spawn.
fn build_merge_argv(
    number: u64,
    owner_repo: &str,
    method: MergeMethod,
    head_sha: &str,
) -> Vec<String> {
    let flag = match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => "--rebase",
    };
    vec![
        "pr".to_string(),
        "merge".to_string(),
        number.to_string(),
        "--repo".to_string(),
        owner_repo.to_string(),
        flag.to_string(),
        "--match-head-commit".to_string(),
        head_sha.to_string(),
    ]
}

/// A non-zero `gh pr merge` exit's stderr/stdout text classified into the right `GhError`,
/// pulled out of `merge_pull_request` so the conflict/not-mergeable text-matching is testable
/// without a live `gh` spawn. Falls back to the shared `map_gh_failure` (used identically by
/// every other `gh` call site) for anything that doesn't match a known not-mergeable shape.
fn classify_merge_failure(stderr: &str, stdout: &str) -> GhError {
    let text = format!("{stderr}\n{stdout}").to_lowercase();
    let not_mergeable = text.contains("not mergeable")
        || text.contains("conflict")
        || text.contains("required status check")
        || (text.contains("review") && text.contains("required"))
        || (text.contains("changes") && text.contains("requested"))
        || text.contains("match-head-commit")
        || text.contains("head commit");
    if not_mergeable {
        return GhError::new(
            GhErrorCode::NotMergeable,
            non_empty_or(stderr, stdout, "This pull request cannot be merged."),
        );
    }
    map_gh_failure(stderr, stdout)
}

#[cfg(test)]
#[path = "gh_mutations_tests.rs"]
mod tests;
