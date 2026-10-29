// Wire shapes (mapped to the renderer's `src/shared/github.ts` entity types) and gh-wire-shape
// -> renderer-shape mapping functions for `pullRequests.*` (lane R9, issue #792). Split out of
// `mod.rs` to stay under the 600-line-per-file cap (issue #806): `mod.rs` keeps the IPC handler
// registration, the staleness cache, and `list`/`buildDetail`'s own orchestration; this file is
// pure data shapes and pure mapping functions, no `gh`/IPC side effects of its own.

use serde::Serialize;

use crate::github::gh::{GhActor, GhCheckRun};
use crate::github::gh_mutations::{
    GhThreadsAndTimeline, GhTimelineNode, MergeMethod, ReviewVerdict,
};
use crate::github::gh_pull_requests::{GhPrViewDetail, GhRestFile};

use super::checks::PullRequestCheck;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    User,
    Bot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestActor {
    pub login: String,
    pub name: Option<String>,
    pub kind: ActorKind,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Draft,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStateOrNone {
    Pending,
    Passed,
    Failed,
    None,
}

/// One row in the list (FR-005). `repository` is `"owner/repo"`, for the row's Repository
/// column.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub state: PullRequestState,
    pub check_state: CheckStateOrNone,
    pub repository: String,
    pub updated_at: String,
    pub author: PullRequestActor,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestListResult {
    pub items: Vec<PullRequestSummary>,
    pub fetched_at: String,
}

/// One entry in the Changes tab (FR-009). `patch: None` is the per-file truncation signal; it
/// never means "no changes".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeableState {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)] // Kept for wire-shape parity with `AutomatedFinding.severity`; this build
                    // never constructs a non-empty `findings` list (see that struct's own doc comment), so no
                    // variant is ever actually matched/constructed, but the type must still exist and serialise
                    // correctly if a future slice starts populating it.
pub enum FindingSeverity {
    Low,
    Medium,
    High,
    Critical,
    Unknown,
}

/// Non-empty only for an automated reviewer's review; a human review's `findings` is always
/// `[]` -- no dedicated GraphQL field and no live Copilot-review sample exists to confirm a body
/// convention, so this build never constructs one, but the shape is kept for wire parity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomatedFinding {
    pub severity: FindingSeverity,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub author: PullRequestActor,
    pub verdict: ReviewVerdict,
    pub body: String,
    pub submitted_at: String,
    pub findings: Vec<AutomatedFinding>,
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub author: PullRequestActor,
    pub body: String,
    pub created_at: String,
    pub edited: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<i64>,
    pub diff_side: DiffSide,
    pub resolved: bool,
    pub comments: Vec<ReviewComment>,
}

/// The Overview's ordered timeline (FR-008): commits, general comments, submitted reviews, and
/// review threads, in chronological order.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TimelineEntry {
    Commit {
        sha: String,
        message: String,
        author: PullRequestActor,
        committed_at: String,
    },
    Comment {
        id: String,
        author: PullRequestActor,
        body: String,
        created_at: String,
        edited: bool,
    },
    Review {
        review: Review,
    },
    ReviewThread {
        thread: ReviewThread,
    },
}

/// The Overview tab's content plus everything the detail view's header actions need to decide
/// what's offered (FR-007, FR-016, FR-019, FR-020).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub state: PullRequestState,
    pub base_branch: String,
    pub head_branch: String,
    pub author: PullRequestActor,
    pub reviewers: Vec<PullRequestActor>,
    pub assignees: Vec<PullRequestActor>,
    pub labels: Vec<String>,
    pub description: String,
    pub timeline: Vec<TimelineEntry>,
    pub check_state: CheckStateOrNone,
    pub checks: Vec<PullRequestCheck>,
    pub viewer_login: Option<String>,
    pub mergeable_state: MergeableState,
    pub review_disabled_reason: Option<String>,
    pub merge_disabled_reason: Option<String>,
    pub allowed_merge_methods: Vec<MergeMethod>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files_count: u64,
    pub files: Vec<ChangedFile>,
    pub url: String,
    pub updated_at: String,
    pub head_sha: String,
    pub is_fork: bool,
    pub head_repository_owner: Option<String>,
}

// ---------------------------------------------------------------------------
// Mapping: gh wire shapes -> renderer entity shapes
// ---------------------------------------------------------------------------

/// Gate round 1 fix (#568 decision 6, Code High): `isDraft` alone used to short-circuit straight
/// to Draft, which mislabelled a CLOSED draft pull request (GitHub keeps `isDraft: true` on a
/// draft that was closed without being marked ready) as "Draft" on every one of the four
/// relation-tab searches that actually include closed pull requests. Draft only applies while
/// the pull request is still open; a closed or merged draft reads as Closed/Merged like any
/// other pull request in that state.
pub fn map_pull_request_state(state: &str, is_draft: bool) -> PullRequestState {
    let upper = state.to_uppercase();
    if is_draft && upper == "OPEN" {
        return PullRequestState::Draft;
    }
    match upper.as_str() {
        "MERGED" => PullRequestState::Merged,
        "CLOSED" => PullRequestState::Closed,
        _ => PullRequestState::Open,
    }
}

pub fn map_actor(actor: Option<&GhActor>) -> PullRequestActor {
    PullRequestActor {
        login: actor
            .and_then(|a| a.login.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        name: actor.and_then(|a| a.name.clone()),
        kind: if actor.is_some_and(|a| a.is_bot || a.typename.as_deref() == Some("Bot")) {
            ActorKind::Bot
        } else {
            ActorKind::User
        },
        avatar_url: actor.and_then(|a| a.avatar_url.clone()),
    }
}

/// A commit's GraphQL author is `{ name: string } | null` -- no `login` at all, since a commit
/// can be authored with an email that isn't linked to a GitHub account. `name` doubles as the
/// fallback `login` so the UI always has something stable to key/display on.
pub fn map_commit_author(name: Option<&str>) -> PullRequestActor {
    PullRequestActor {
        login: name.unwrap_or("unknown").to_string(),
        name: name.map(str::to_string),
        kind: ActorKind::User,
        avatar_url: None,
    }
}

const PENDING_STATUSES: &[&str] = &["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"];
const FAILED_CONCLUSIONS: &[&str] = &[
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
];

pub fn map_check_state(runs: Option<&[GhCheckRun]>) -> CheckStateOrNone {
    let Some(runs) = runs else {
        return CheckStateOrNone::None;
    };
    if runs.is_empty() {
        return CheckStateOrNone::None;
    }
    let is_pending = runs.iter().any(|run| {
        let status = run.status.as_deref().unwrap_or("").to_uppercase();
        let state = run.state.as_deref().unwrap_or("").to_uppercase();
        PENDING_STATUSES.contains(&status.as_str()) || state == "PENDING"
    });
    if is_pending {
        return CheckStateOrNone::Pending;
    }
    let is_failed = runs.iter().any(|run| {
        let conclusion = run.conclusion.as_deref().unwrap_or("").to_uppercase();
        let state = run.state.as_deref().unwrap_or("").to_uppercase();
        FAILED_CONCLUSIONS.contains(&conclusion.as_str()) || state == "FAILURE" || state == "ERROR"
    });
    if is_failed {
        CheckStateOrNone::Failed
    } else {
        CheckStateOrNone::Passed
    }
}

/// `PullRequestDetail.reviewDisabledReason` (FR-019): review actions are only ever disabled by
/// the pull request's own state -- draft, closed, or merged.
pub fn compute_review_disabled_reason(state: PullRequestState) -> Option<String> {
    match state {
        PullRequestState::Draft => Some("This pull request is a draft.".to_string()),
        PullRequestState::Closed => Some("This pull request is closed.".to_string()),
        PullRequestState::Merged => Some("This pull request is already merged.".to_string()),
        PullRequestState::Open => None,
    }
}

/// `PullRequestDetail.mergeDisabledReason` (FR-019, FR-020): merge-only concerns layered on top
/// of the same state gate -- conflicts and a blocked merge state. `UNSTABLE` (only non-required
/// checks failing) is deliberately never folded in here: GitHub itself still allows merging in
/// that case.
pub fn compute_merge_disabled_reason(
    state: PullRequestState,
    mergeable: &str,
    merge_state_status: &str,
) -> Option<String> {
    if let Some(reason) = compute_review_disabled_reason(state) {
        return Some(reason);
    }
    if mergeable.eq_ignore_ascii_case("CONFLICTING") {
        return Some("This pull request has merge conflicts.".to_string());
    }
    match merge_state_status.to_uppercase().as_str() {
        "DIRTY" => Some("This pull request has merge conflicts.".to_string()),
        "BLOCKED" => Some(
            "This pull request is blocked: required reviews or required checks have not been satisfied yet."
                .to_string(),
        ),
        _ => None,
    }
}

/// `view.mergeable` is a 3-value string enum, not a boolean: `'UNKNOWN'` (GitHub still computing
/// mergeability in the background) gets its own state here so the renderer can show "still
/// checking" rather than a false conflict message.
pub fn map_mergeable_state(mergeable: &str) -> MergeableState {
    match mergeable.to_uppercase().as_str() {
        "MERGEABLE" => MergeableState::Mergeable,
        "CONFLICTING" => MergeableState::Conflicting,
        _ => MergeableState::Unknown,
    }
}

pub fn map_review_verdict(state: Option<&str>) -> Option<ReviewVerdict> {
    match state.unwrap_or("").to_uppercase().as_str() {
        "APPROVED" => Some(ReviewVerdict::Approve),
        "CHANGES_REQUESTED" => Some(ReviewVerdict::RequestChanges),
        "COMMENTED" => Some(ReviewVerdict::Comment),
        // Gate round 2 fix (#568 decision 10 amendment, Code High N1): DISMISSED used to share
        // PENDING's `None` -- a real review state, not a not-yet-submitted one -- which deleted
        // every dismissed review from the Overview `Timeline` entirely (FR-008 regression) once
        // gate round 1 taught `ReviewConsensus` about dismissals via a backend pre-pass. A
        // dismissed review IS a submitted review (it has a real body/author/timestamp); it now
        // keeps its own place in the timeline with a `Dismissed` verdict, and the renderer
        // (`ReviewConsensus.tsx`) decides what a dismissal means for the standing-verdict
        // rollup, not this mapping function.
        "DISMISSED" => Some(ReviewVerdict::Dismissed),
        // PENDING: not yet a submitted verdict at all.
        _ => None,
    }
}

/// FR-011: once the running total of patch bytes across a pull request's changed files would
/// exceed this, every remaining file's patch is dropped (the existing per-file `patch: None`
/// truncation signal, same banner the whole-call REST-failure fallback below already uses) --
/// `get_changed_files_with_patch`'s own `--paginate` has no upper bound on file count or
/// per-file patch size, so an unusually large pull request could otherwise send megabytes of
/// diff text over IPC in one payload (performance finding, code review 2026-10-14).
const MAX_TOTAL_PATCH_BYTES: usize = 2 * 1024 * 1024;

pub fn map_changed_files(
    view: &GhPrViewDetail,
    rest_files: Option<&[GhRestFile]>,
) -> Vec<ChangedFile> {
    if let Some(rest_files) = rest_files {
        let mut total_patch_bytes = 0usize;
        return rest_files
            .iter()
            .map(|file| {
                let keep_patch = file.patch.as_ref().is_some_and(|patch| {
                    total_patch_bytes += patch.len();
                    total_patch_bytes <= MAX_TOTAL_PATCH_BYTES
                });
                ChangedFile {
                    path: file.filename.clone(),
                    additions: file.additions,
                    deletions: file.deletions,
                    patch: if keep_patch { file.patch.clone() } else { None },
                }
            })
            .collect();
    }
    // REST call failed entirely: fall back to the porcelain `files` field (never carries
    // `patch`), so every file reads as truncated (FR-011's banner) rather than losing the file
    // list too.
    view.files
        .iter()
        .map(|file| ChangedFile {
            path: file.path.clone(),
            additions: file.additions,
            deletions: file.deletions,
            patch: None,
        })
        .collect()
}

/// Merges `reviewThreads` + the three relevant `timelineItems` kinds into one chronologically
/// sorted array (FR-008). Gate round 2 fix (#568 decision 10 amendment): the round 1 pre-pass
/// that excluded a dismissed reviewer's reviews from this array entirely is removed -- every
/// review (including a dismissed one, now mapped to a real `Dismissed` verdict above) keeps its
/// place here; `ReviewConsensus.tsx` alone decides what a dismissal means for its own rollup.
pub fn build_timeline(data: &GhThreadsAndTimeline) -> Vec<TimelineEntry> {
    let mut with_timestamps: Vec<(TimelineEntry, String)> = Vec::new();

    for node in &data.timeline_items.nodes {
        match node.__typename.as_str() {
            "PullRequestCommit" => {
                if let Some(commit) = &node.commit {
                    let author_name = commit.author.as_ref().and_then(|a| a.name.as_deref());
                    with_timestamps.push((
                        TimelineEntry::Commit {
                            sha: commit.oid.clone(),
                            message: commit.message.clone(),
                            author: map_commit_author(author_name),
                            committed_at: commit.committed_date.clone(),
                        },
                        commit.committed_date.clone(),
                    ));
                }
            }
            "IssueComment" => {
                if let Some(id) = &node.id {
                    let created_at = node.created_at.clone().unwrap_or_default();
                    with_timestamps.push((
                        TimelineEntry::Comment {
                            id: id.clone(),
                            author: map_actor(node.author.as_ref()),
                            body: node.body.clone().unwrap_or_default(),
                            created_at: created_at.clone(),
                            edited: node.last_edited_at.is_some(),
                        },
                        created_at,
                    ));
                }
            }
            "PullRequestReview" => {
                if let (Some(id), Some(verdict)) =
                    (&node.id, map_review_verdict(node.state.as_deref()))
                {
                    let submitted_at = node.submitted_at.clone().unwrap_or_default();
                    let review = Review {
                        id: id.clone(),
                        author: map_actor(node.author.as_ref()),
                        verdict,
                        body: node.body.clone().unwrap_or_default(),
                        submitted_at: submitted_at.clone(),
                        findings: Vec::new(),
                        edited: node.last_edited_at.is_some(),
                    };
                    with_timestamps.push((TimelineEntry::Review { review }, submitted_at));
                }
            }
            _ => {}
        }
    }

    for thread_node in &data.review_threads.nodes {
        let comments: Vec<ReviewComment> = thread_node
            .comments
            .nodes
            .iter()
            .map(|c| ReviewComment {
                id: c.id.clone(),
                author: map_actor(c.author.as_ref()),
                body: c.body.clone(),
                created_at: c.created_at.clone(),
                edited: c.last_edited_at.is_some(),
            })
            .collect();
        let ts = comments
            .first()
            .map(|c| c.created_at.clone())
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
        let thread = ReviewThread {
            id: thread_node.id.clone(),
            path: thread_node.path.clone(),
            line: thread_node.line,
            diff_side: if thread_node.diff_side.eq_ignore_ascii_case("LEFT") {
                DiffSide::Left
            } else {
                DiffSide::Right
            },
            resolved: thread_node.is_resolved,
            comments,
        };
        with_timestamps.push((TimelineEntry::ReviewThread { thread }, ts));
    }

    with_timestamps.sort_by(|a, b| a.1.cmp(&b.1));
    with_timestamps
        .into_iter()
        .map(|(entry, _)| entry)
        .collect()
}

/// Narrow helper so `mod.rs`'s `__typename` match above never needs to import `GhTimelineNode`
/// itself just to reference its type in a doc comment.
#[allow(dead_code)]
fn _typename_reference(_: &GhTimelineNode) {}

// Fixture-based tests for the mapping functions above (issue #792's own named ask: "write
// fixtures from recorded `gh` output for list, detail, review submit and merge"). Split into a
// sibling file -- the same pattern `session/agent` already uses for splitting a module by
// concern -- to stay under the 600-line-per-file cap (issue #806).
#[cfg(test)]
#[path = "mapping_tests.rs"]
mod mapping_tests;
