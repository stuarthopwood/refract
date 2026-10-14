// Recorded-`gh`-output fixtures for `GhPrListEntry`/`GhSearchEntry`/`GhPrViewDetail` (issue #792's
// own named ask: "write fixtures from recorded `gh` output for list, detail, review submit and
// merge"), deserialised from real camelCase JSON strings via `serde_json::from_str` and run
// through the pure mapping functions in `mapping.rs`, rather than constructed as Rust struct
// literals -- the regression test for the HIGH finding (code review, 2026-10-14) that a Team
// review request (no `login` key at all in `gh`'s own wire shape) used to fail to map rather than
// falling back to `login: "unknown"`. Nested as a child of `mapping_tests.rs` (not a direct
// sibling of `mapping.rs`) purely to stay under the 600-line-per-file cap (issue #806) while still
// reaching `mapping.rs`'s privately-imported items through `mapping_tests.rs`'s own
// `use super::*;`.

use super::*;
use crate::github::gh_pull_requests::{GhPrListEntry, GhSearchEntry};

/// A team review request has no `login` key at all in real `gh`/GraphQL output (`gh.rs`'s own
/// `GhActor` doc comment) -- `#[serde(default)]` on both of `GhActor`'s fields lets it deserialise
/// with `login: None` instead of failing to parse.
const TEAM_REVIEWER_JSON: &str = r#"{"name":"Some Team","__typename":"Team"}"#;

#[test]
fn gh_pr_list_entry_deserialises_camel_case_and_maps_team_reviewer_to_unknown() {
    let json = format!(
        r#"{{
            "number": 42,
            "title": "Add README",
            "state": "OPEN",
            "isDraft": false,
            "author": {{"login": "octocat", "name": null}},
            "headRefName": "feature",
            "baseRefName": "main",
            "updatedAt": "2024-01-01T00:00:00Z",
            "statusCheckRollup": [{{"status": "COMPLETED", "conclusion": "SUCCESS", "state": null}}],
            "labels": [{{"name": "bug"}}],
            "reviewRequests": [{TEAM_REVIEWER_JSON}, {{"login": "reviewer-1", "name": null}}],
            "assignees": [{{"login": "octocat", "name": null}}]
        }}"#
    );
    let entry: GhPrListEntry = serde_json::from_str(&json).expect("GhPrListEntry fixture parses");

    assert_eq!(entry.number, 42);
    assert!(matches!(
        map_pull_request_state(&entry.state, entry.is_draft),
        PullRequestState::Open
    ));
    assert_eq!(map_actor(Some(&entry.author)).login, "octocat");
    let team = map_actor(entry.review_requests.first());
    assert_eq!(team.login, "unknown");
    assert_eq!(team.name, Some("Some Team".to_string()));
    assert_eq!(map_actor(entry.review_requests.get(1)).login, "reviewer-1");
    assert_eq!(
        map_check_state(entry.status_check_rollup.as_deref()),
        CheckStateOrNone::Passed
    );
}

#[test]
fn gh_search_entry_deserialises_camel_case() {
    let json = r#"{
        "number": 9,
        "title": "Tidy docs",
        "state": "MERGED",
        "author": {"login": "octocat", "name": null},
        "url": "https://github.com/stuarthopwood/refract/pull/9",
        "updatedAt": "2024-02-02T00:00:00Z",
        "labels": [{"name": "docs"}]
    }"#;
    let entry: GhSearchEntry = serde_json::from_str(json).expect("GhSearchEntry fixture parses");

    assert!(matches!(
        map_pull_request_state(&entry.state, false),
        PullRequestState::Merged
    ));
    assert_eq!(map_actor(Some(&entry.author)).login, "octocat");
    assert_eq!(entry.url, "https://github.com/stuarthopwood/refract/pull/9");
}

/// `headRepositoryOwner` carries no `#[serde(default)]` -- real `gh` always sends the key, either
/// an actor object (cross-repository) or `null` (same-repository), never omitted outright.
fn gh_pr_view_detail_json(is_cross_repository: bool, head_repository_owner: &str) -> String {
    format!(
        r#"{{
            "title": "Fix bug",
            "number": 7,
            "state": "OPEN",
            "author": {{"login": "octocat", "name": null}},
            "baseRefName": "main",
            "headRefName": "octocat:fix-bug",
            "reviewRequests": [{TEAM_REVIEWER_JSON}],
            "assignees": [],
            "labels": [],
            "commits": [{{"oid": "abc123", "messageHeadline": "Fix bug"}}],
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "additions": 3,
            "deletions": 1,
            "changedFiles": 1,
            "files": [{{"path": "src/lib.rs", "additions": 3, "deletions": 1, "changeType": "modified"}}],
            "isDraft": false,
            "statusCheckRollup": null,
            "updatedAt": "2024-05-01T00:00:00Z",
            "headRefOid": "abc123",
            "body": "This fixes a bug.",
            "isCrossRepository": {is_cross_repository},
            "headRepositoryOwner": {head_repository_owner}
        }}"#
    )
}

#[test]
fn gh_pr_view_detail_deserialises_camel_case_cross_repository_true_with_owner() {
    let json = gh_pr_view_detail_json(true, r#"{"login": "octocat", "name": null}"#);
    let detail: GhPrViewDetail =
        serde_json::from_str(&json).expect("GhPrViewDetail (cross-repo) fixture parses");

    assert!(detail.is_cross_repository);
    assert_eq!(
        map_actor(detail.head_repository_owner.as_ref()).login,
        "octocat"
    );
    let team = map_actor(detail.review_requests.first());
    assert_eq!(team.login, "unknown");
    assert_eq!(team.name, Some("Some Team".to_string()));
    assert_eq!(
        map_check_state(detail.status_check_rollup.as_deref()),
        CheckStateOrNone::None
    );
    let changed = map_changed_files(&detail, None);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].path, "src/lib.rs");
    assert_eq!(changed[0].patch, None);
}

#[test]
fn gh_pr_view_detail_deserialises_camel_case_cross_repository_false_without_owner() {
    let json = gh_pr_view_detail_json(false, "null");
    let detail: GhPrViewDetail =
        serde_json::from_str(&json).expect("GhPrViewDetail (same-repo) fixture parses");

    assert!(!detail.is_cross_repository);
    assert!(detail.head_repository_owner.is_none());
}

/// The inner `pullRequest` shape `get_review_threads_and_timeline` (`gh_mutations.rs`) actually
/// hands `build_timeline`, deserialised from JSON rather than constructed as a struct literal
/// (unlike `mapping_tests.rs`'s own `GhThreadsAndTimeline` cases) specifically to exercise the
/// `__typename` discriminator and three null-shaped fields real `gh`/GraphQL output sends: a
/// review thread's `line: null` (file-level comment), a timeline node's `author: null` (deleted
/// account), and a pending `PullRequestReview`'s `submittedAt: null` -- the full envelope
/// (`{"repository":{"pullRequest":{...}}}`) is deserialised separately in `gh_mutations_tests.rs`,
/// which can see its private wrapper structs; this test starts one layer in, at the already-
/// unwrapped shape `build_timeline` itself reads.
#[test]
fn threads_and_timeline_json_fixture_maps_through_build_timeline() {
    let json = r#"{
        "id": "PR_1",
        "reviewThreads": {
            "nodes": [
                {
                    "id": "THREAD_1",
                    "isResolved": false,
                    "isOutdated": false,
                    "path": "src/lib.rs",
                    "line": null,
                    "diffSide": "RIGHT",
                    "comments": {
                        "nodes": [
                            {
                                "id": "COMMENT_1",
                                "author": { "login": "alice" },
                                "body": "looks good",
                                "createdAt": "2024-01-01T00:00:00Z"
                            }
                        ]
                    }
                }
            ]
        },
        "timelineItems": {
            "nodes": [
                {
                    "__typename": "IssueComment",
                    "id": "IC_1",
                    "author": null,
                    "body": "a comment",
                    "createdAt": "2024-01-02T00:00:00Z"
                },
                {
                    "__typename": "PullRequestReview",
                    "id": "REVIEW_1",
                    "author": { "login": "bob" },
                    "state": "PENDING",
                    "body": "",
                    "submittedAt": null
                }
            ]
        }
    }"#;
    let data: GhThreadsAndTimeline =
        serde_json::from_str(json).expect("GhThreadsAndTimeline fixture parses");

    let timeline = build_timeline(&data);
    // The pending review is dropped (no verdict); only the comment and the review thread
    // remain, chronologically ordered by their earliest timestamp: the thread's first comment
    // (2024-01-01) sorts before the issue comment (2024-01-02).
    assert_eq!(timeline.len(), 2);
    match &timeline[0] {
        TimelineEntry::ReviewThread { thread } => {
            assert_eq!(thread.id, "THREAD_1");
            assert_eq!(thread.line, None);
        }
        other => panic!("expected a ReviewThread entry, got {other:?}"),
    }
    match &timeline[1] {
        TimelineEntry::Comment { id, author, .. } => {
            assert_eq!(id, "IC_1");
            assert_eq!(author.login, "unknown");
        }
        other => panic!("expected a Comment entry, got {other:?}"),
    }
}
