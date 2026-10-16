// Fixture-based tests for `mapping.rs`'s pure gh-wire-shape -> renderer-shape mapping functions
// (lane R9, issue #792's own named ask: "write fixtures from recorded `gh` output for list,
// detail, review submit and merge"). Split from `mapping.rs` itself (`#[path = "mapping_tests.rs"]`
// at its tail) to stay under the 600-line-per-file cap (issue #806), the same pattern
// `session/agent` already uses for splitting a module by concern, applied test-only here.
//
// `GhRestFile` (REST, single-word field names) and, as of this round, `GhPrListEntry`,
// `GhSearchEntry`, and `GhPrViewDetail` (all now `#[serde(rename_all = "camelCase")]`) are each
// deserialised from a JSON string via `serde_json::from_str` -- the most faithful stand-in for
// recorded `gh pr list --json`/`gh search prs --json`/`gh pr view --json` output, and the
// regression test for the HIGH finding (code review, 2026-10-14) that a Team review request (no
// `login` key at all in real `gh` output) used to fail to map to `login: "unknown"`. Those three
// JSON-fixture tests live in a further child module, `mapping_fixtures_tests.rs`, to stay under
// this file's own 600-line cap.
//
// `gh_mutations`'s GraphQL wire shapes (`GhThreadsAndTimeline`/`GhTimelineNode`/
// `GhReviewThreadNode` and friends) are still constructed directly as Rust struct literals below,
// even though they too now carry `#[serde(rename_all = "camelCase")]`: a faithful JSON fixture for
// them would have to hand-maintain the full nested GraphQL response envelope
// (`{"data":{"repository":{"pullRequest":{...}}}}`) `THREADS_AND_TIMELINE_QUERY` actually returns,
// for no behavioural gain over directly constructing the already-unwrapped inner shape these
// mapping functions read -- struct-literal construction says exactly what's varied per test case.

use super::*;
use crate::github::gh_mutations::{
    GhReviewThreadComment, GhReviewThreadComments, GhReviewThreadNode, GhReviewThreadsNodes,
    GhTimelineCommit, GhTimelineCommitAuthor, GhTimelineNodes,
};
use crate::github::gh_pull_requests::GhRestFileLite;

#[test]
fn map_pull_request_state_maps_draft_open_closed_merged() {
    assert!(matches!(
        map_pull_request_state("OPEN", true),
        PullRequestState::Draft
    ));
    assert!(matches!(
        map_pull_request_state("OPEN", false),
        PullRequestState::Open
    ));
    assert!(matches!(
        map_pull_request_state("CLOSED", false),
        PullRequestState::Closed
    ));
    assert!(matches!(
        map_pull_request_state("MERGED", false),
        PullRequestState::Merged
    ));
    // Gate round 1 fix (#568 decision 6): a draft that was closed without being marked ready
    // still carries `isDraft: true` on GitHub's own search surface, so `is_draft` alone must
    // not override a non-OPEN state.
    assert!(matches!(
        map_pull_request_state("CLOSED", true),
        PullRequestState::Closed
    ));
    assert!(matches!(
        map_pull_request_state("MERGED", true),
        PullRequestState::Merged
    ));
}

fn check_run(status: Option<&str>, conclusion: Option<&str>, state: Option<&str>) -> GhCheckRun {
    GhCheckRun {
        status: status.map(str::to_string),
        conclusion: conclusion.map(str::to_string),
        state: state.map(str::to_string),
    }
}

#[test]
fn map_check_state_none_when_absent_or_empty() {
    assert_eq!(map_check_state(None), CheckStateOrNone::None);
    assert_eq!(map_check_state(Some(&[])), CheckStateOrNone::None);
}

#[test]
fn map_check_state_pending_when_any_run_in_progress() {
    let runs = [
        check_run(Some("COMPLETED"), Some("SUCCESS"), None),
        check_run(Some("IN_PROGRESS"), None, None),
    ];
    assert_eq!(map_check_state(Some(&runs)), CheckStateOrNone::Pending);
}

#[test]
fn map_check_state_failed_when_any_run_failed() {
    let runs = [
        check_run(Some("COMPLETED"), Some("SUCCESS"), None),
        check_run(Some("COMPLETED"), Some("FAILURE"), None),
    ];
    assert_eq!(map_check_state(Some(&runs)), CheckStateOrNone::Failed);
}

#[test]
fn map_check_state_passed_when_all_runs_pass() {
    let runs = [
        check_run(Some("COMPLETED"), Some("SUCCESS"), None),
        check_run(Some("COMPLETED"), Some("NEUTRAL"), None),
    ];
    assert_eq!(map_check_state(Some(&runs)), CheckStateOrNone::Passed);
}

#[test]
fn compute_review_disabled_reason_covers_every_state() {
    assert_eq!(compute_review_disabled_reason(PullRequestState::Open), None);
    assert_eq!(
        compute_review_disabled_reason(PullRequestState::Draft),
        Some("This pull request is a draft.".to_string())
    );
    assert_eq!(
        compute_review_disabled_reason(PullRequestState::Closed),
        Some("This pull request is closed.".to_string())
    );
    assert_eq!(
        compute_review_disabled_reason(PullRequestState::Merged),
        Some("This pull request is already merged.".to_string())
    );
}

#[test]
fn compute_merge_disabled_reason_defers_to_the_review_gate_first() {
    assert_eq!(
        compute_merge_disabled_reason(PullRequestState::Draft, "MERGEABLE", "CLEAN"),
        Some("This pull request is a draft.".to_string())
    );
}

#[test]
fn compute_merge_disabled_reason_conflicting_mergeable_wins_over_open_state() {
    assert_eq!(
        compute_merge_disabled_reason(PullRequestState::Open, "CONFLICTING", "CLEAN"),
        Some("This pull request has merge conflicts.".to_string())
    );
}

#[test]
fn compute_merge_disabled_reason_dirty_merge_state_status_reads_as_conflicting() {
    assert_eq!(
        compute_merge_disabled_reason(PullRequestState::Open, "MERGEABLE", "DIRTY"),
        Some("This pull request has merge conflicts.".to_string())
    );
}

#[test]
fn compute_merge_disabled_reason_blocked_merge_state_status() {
    assert_eq!(
        compute_merge_disabled_reason(PullRequestState::Open, "MERGEABLE", "BLOCKED"),
        Some(
            "This pull request is blocked: required reviews or required checks have not been satisfied yet."
                .to_string()
        )
    );
}

#[test]
fn compute_merge_disabled_reason_clean_open_pull_request_is_none() {
    assert_eq!(
        compute_merge_disabled_reason(PullRequestState::Open, "MERGEABLE", "CLEAN"),
        None
    );
}

#[test]
fn map_mergeable_state_covers_all_three_values() {
    assert!(matches!(
        map_mergeable_state("MERGEABLE"),
        MergeableState::Mergeable
    ));
    assert!(matches!(
        map_mergeable_state("CONFLICTING"),
        MergeableState::Conflicting
    ));
    assert!(matches!(
        map_mergeable_state("UNKNOWN"),
        MergeableState::Unknown
    ));
}

#[test]
fn map_review_verdict_covers_none_and_every_submitted_state() {
    assert_eq!(map_review_verdict(None), None);
    assert_eq!(
        map_review_verdict(Some("APPROVED")),
        Some(ReviewVerdict::Approve)
    );
    assert_eq!(
        map_review_verdict(Some("CHANGES_REQUESTED")),
        Some(ReviewVerdict::RequestChanges)
    );
    assert_eq!(
        map_review_verdict(Some("COMMENTED")),
        Some(ReviewVerdict::Comment)
    );
}

/// `GhPrViewDetail` has no `Default`; this fills every field with a plausible value so each test
/// only needs to vary the one field (`files`) `map_changed_files`'s fallback path reads.
fn sample_pr_view_detail(files: Vec<GhRestFileLite>) -> GhPrViewDetail {
    GhPrViewDetail {
        title: "Add README".to_string(),
        number: 42,
        state: "OPEN".to_string(),
        author: GhActor {
            login: Some("octocat".to_string()),
            name: None,
        },
        base_ref_name: "main".to_string(),
        head_ref_name: "feature".to_string(),
        review_requests: Vec::new(),
        assignees: Vec::new(),
        labels: Vec::new(),
        commits: Vec::new(),
        merge_state_status: "CLEAN".to_string(),
        mergeable: "MERGEABLE".to_string(),
        additions: 0,
        deletions: 0,
        changed_files: files.len() as u64,
        files,
        is_draft: false,
        status_check_rollup: None,
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        head_ref_oid: "deadbeef".to_string(),
        body: String::new(),
        is_cross_repository: false,
        head_repository_owner: None,
    }
}

#[test]
fn map_changed_files_prefers_rest_files_and_preserves_patch_presence() {
    let with_patch: GhRestFile = serde_json::from_str(
        r#"{"filename":"src/lib.rs","additions":12,"deletions":3,"patch":"@@ -1,3 +1,4 @@\n+use foo;\n","status":"modified"}"#,
    )
    .expect("GhRestFile fixture parses");
    // GitHub's REST files API omits `patch` entirely once a file exceeds its per-file size
    // threshold -- the truncation signal `map_changed_files` must preserve, never read as "no
    // changes".
    let truncated: GhRestFile = serde_json::from_str(
        r#"{"filename":"assets/image.png","additions":0,"deletions":0,"status":"modified"}"#,
    )
    .expect("GhRestFile fixture parses");
    let rest_files = [with_patch, truncated];
    let view = sample_pr_view_detail(Vec::new());

    let mapped = map_changed_files(&view, Some(&rest_files));

    assert_eq!(mapped.len(), 2);
    assert_eq!(mapped[0].path, "src/lib.rs");
    assert_eq!(
        mapped[0].patch.as_deref(),
        Some("@@ -1,3 +1,4 @@\n+use foo;\n")
    );
    assert_eq!(mapped[1].path, "assets/image.png");
    assert_eq!(
        mapped[1].patch, None,
        "an absent REST patch is a truncation signal, not 'no changes'"
    );
}

#[test]
fn map_changed_files_falls_back_to_porcelain_files_with_patch_always_none() {
    let view = sample_pr_view_detail(vec![GhRestFileLite {
        path: "src/main.rs".to_string(),
        additions: 5,
        deletions: 1,
        change_type: "modified".to_string(),
    }]);

    let mapped = map_changed_files(&view, None);

    assert_eq!(mapped.len(), 1);
    assert_eq!(mapped[0].path, "src/main.rs");
    assert_eq!(mapped[0].patch, None);
}

fn gh_timeline_node_commit(
    sha: &str,
    message: &str,
    author_name: &str,
    committed_date: &str,
) -> GhTimelineNode {
    GhTimelineNode {
        __typename: "PullRequestCommit".to_string(),
        commit: Some(GhTimelineCommit {
            oid: sha.to_string(),
            message: message.to_string(),
            committed_date: committed_date.to_string(),
            author: Some(GhTimelineCommitAuthor {
                name: Some(author_name.to_string()),
            }),
        }),
        id: None,
        author: None,
        body: None,
        created_at: None,
        state: None,
        submitted_at: None,
    }
}

fn gh_timeline_node_comment(id: &str, login: &str, body: &str, created_at: &str) -> GhTimelineNode {
    GhTimelineNode {
        __typename: "IssueComment".to_string(),
        commit: None,
        id: Some(id.to_string()),
        author: Some(GhActor {
            login: Some(login.to_string()),
            name: None,
        }),
        body: Some(body.to_string()),
        created_at: Some(created_at.to_string()),
        state: None,
        submitted_at: None,
    }
}

fn gh_timeline_node_review(
    id: &str,
    login: &str,
    state: &str,
    body: &str,
    submitted_at: &str,
) -> GhTimelineNode {
    GhTimelineNode {
        __typename: "PullRequestReview".to_string(),
        commit: None,
        id: Some(id.to_string()),
        author: Some(GhActor {
            login: Some(login.to_string()),
            name: None,
        }),
        body: Some(body.to_string()),
        created_at: None,
        state: Some(state.to_string()),
        submitted_at: Some(submitted_at.to_string()),
    }
}

#[test]
fn build_timeline_sorts_commit_review_comment_and_thread_chronologically() {
    // Deliberately out of order in the fixture (comment, commit, review, with the thread's own
    // comment latest of all) to prove `build_timeline` actually sorts rather than happening to
    // preserve input order.
    let data = GhThreadsAndTimeline {
        id: "PR_kwFOAbc".to_string(),
        review_threads: GhReviewThreadsNodes {
            nodes: vec![GhReviewThreadNode {
                id: "thread-1".to_string(),
                is_resolved: false,
                is_outdated: false,
                path: "src/lib.rs".to_string(),
                line: Some(10),
                diff_side: "RIGHT".to_string(),
                comments: GhReviewThreadComments {
                    nodes: vec![GhReviewThreadComment {
                        id: "thread-comment-1".to_string(),
                        author: Some(GhActor {
                            login: Some("reviewer".to_string()),
                            name: None,
                        }),
                        body: "Please fix this.".to_string(),
                        created_at: "2024-04-01T00:00:00Z".to_string(),
                    }],
                },
            }],
        },
        timeline_items: GhTimelineNodes {
            nodes: vec![
                gh_timeline_node_comment(
                    "comment-1",
                    "octocat",
                    "Looks good.",
                    "2024-03-01T00:00:00Z",
                ),
                gh_timeline_node_commit(
                    "sha1",
                    "Initial commit",
                    "octocat",
                    "2024-01-01T00:00:00Z",
                ),
                gh_timeline_node_review(
                    "review-1",
                    "octocat",
                    "APPROVED",
                    "LGTM",
                    "2024-02-01T00:00:00Z",
                ),
            ],
        },
    };

    let timeline = build_timeline(&data);

    assert_eq!(timeline.len(), 4);
    let timestamps: Vec<&str> = timeline
        .iter()
        .map(|entry| match entry {
            TimelineEntry::Commit { committed_at, .. } => committed_at.as_str(),
            TimelineEntry::Comment { created_at, .. } => created_at.as_str(),
            TimelineEntry::Review { review } => review.submitted_at.as_str(),
            TimelineEntry::ReviewThread { thread } => thread
                .comments
                .first()
                .map(|c| c.created_at.as_str())
                .unwrap_or_default(),
        })
        .collect();
    assert_eq!(
        timestamps,
        vec![
            "2024-01-01T00:00:00Z",
            "2024-02-01T00:00:00Z",
            "2024-03-01T00:00:00Z",
            "2024-04-01T00:00:00Z",
        ]
    );
    assert!(matches!(timeline[0], TimelineEntry::Commit { .. }));
    assert!(matches!(timeline[1], TimelineEntry::Review { .. }));
    assert!(matches!(timeline[2], TimelineEntry::Comment { .. }));
    assert!(matches!(timeline[3], TimelineEntry::ReviewThread { .. }));
}

#[test]
fn build_timeline_maps_team_actor_to_unknown_login() {
    // A team review request/comment author has no `login` key at all in real `gh`/GraphQL output
    // (`gh.rs`'s own `GhActor` doc comment) -- `map_actor` must fall back to `"unknown"`, not
    // panic or misread `name` as the login.
    let data = GhThreadsAndTimeline {
        id: "PR_kwFOTeam".to_string(),
        review_threads: GhReviewThreadsNodes { nodes: vec![] },
        timeline_items: GhTimelineNodes {
            nodes: vec![GhTimelineNode {
                __typename: "IssueComment".to_string(),
                commit: None,
                id: Some("comment-team".to_string()),
                author: Some(GhActor {
                    login: None,
                    name: Some("Some Team".to_string()),
                }),
                body: Some("On behalf of the team.".to_string()),
                created_at: Some("2024-06-01T00:00:00Z".to_string()),
                state: None,
                submitted_at: None,
            }],
        },
    };

    let timeline = build_timeline(&data);

    assert_eq!(timeline.len(), 1);
    match &timeline[0] {
        TimelineEntry::Comment { author, .. } => {
            assert_eq!(author.login, "unknown");
            assert_eq!(author.name, Some("Some Team".to_string()));
        }
        other => panic!("expected a Comment entry, got {other:?}"),
    }
}

#[test]
fn build_timeline_skips_unknown_typename_node() {
    // `build_timeline`'s `__typename` match has a catch-all `_ => {}` arm (any future
    // `timelineItems` kind this build doesn't yet render): confirms it's silently skipped rather
    // than erroring or being mistaken for one of the three handled kinds.
    let data = GhThreadsAndTimeline {
        id: "PR_kwFOUnknown".to_string(),
        review_threads: GhReviewThreadsNodes { nodes: vec![] },
        timeline_items: GhTimelineNodes {
            nodes: vec![
                gh_timeline_node_commit(
                    "sha-known",
                    "Known commit",
                    "octocat",
                    "2024-01-01T00:00:00Z",
                ),
                GhTimelineNode {
                    __typename: "SomeFutureNodeKind".to_string(),
                    commit: None,
                    id: Some("future-1".to_string()),
                    author: None,
                    body: None,
                    created_at: None,
                    state: None,
                    submitted_at: None,
                },
            ],
        },
    };

    let timeline = build_timeline(&data);

    assert_eq!(timeline.len(), 1);
    assert!(matches!(timeline[0], TimelineEntry::Commit { .. }));
}

#[test]
fn build_timeline_tie_break_preserves_relative_order_for_identical_timestamps() {
    // `[T]::sort_by` is a documented stable sort: two entries with an identical timestamp keep
    // their original relative order rather than swapping unpredictably or panicking.
    let data = GhThreadsAndTimeline {
        id: "PR_kwFOTie".to_string(),
        review_threads: GhReviewThreadsNodes { nodes: vec![] },
        timeline_items: GhTimelineNodes {
            nodes: vec![
                gh_timeline_node_comment(
                    "comment-first",
                    "octocat",
                    "First.",
                    "2024-07-01T00:00:00Z",
                ),
                gh_timeline_node_comment(
                    "comment-second",
                    "octocat",
                    "Second.",
                    "2024-07-01T00:00:00Z",
                ),
            ],
        },
    };

    let timeline = build_timeline(&data);

    assert_eq!(timeline.len(), 2);
    let bodies: Vec<&str> = timeline
        .iter()
        .map(|entry| match entry {
            TimelineEntry::Comment { body, .. } => body.as_str(),
            other => panic!("expected Comment entries, got {other:?}"),
        })
        .collect();
    assert_eq!(bodies, vec!["First.", "Second."]);
}

// `GhPrListEntry`/`GhSearchEntry`/`GhPrViewDetail` JSON-string fixtures: split out to stay under
// this file's own 600-line cap (issue #806).
#[path = "mapping_fixtures_tests.rs"]
mod mapping_fixtures_tests;
