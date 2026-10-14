// Fixture/unit tests for `gh_mutations.rs` (lane R9, issue #792's own named ask: "write fixtures
// from recorded `gh` output for list, detail, review submit and merge" -- this file covers the
// review-submit and merge half of that ask). Split into a sibling file (`#[path =
// "gh_mutations_tests.rs"]` at `gh_mutations.rs`'s tail), the same pattern
// `ipc/pull_requests/mapping_tests.rs` already uses, to stay under the 600-line-per-file cap
// (issue #806).
//
// `submit_review`/`merge_pull_request`/`get_allowed_merge_methods` themselves spawn a real `gh`
// process, so each has a small pure helper pulled out of it (`build_approve_review_variables`,
// `build_review_argv`, `build_merge_argv`, `allowed_merge_methods_from_wire`,
// `classify_merge_failure`) that this file tests directly -- a narrow, behaviour-preserving
// extraction, not a new code path: every extracted function is called from exactly the same spot
// its inline logic used to sit, with the same inputs and outputs.

use super::*;

#[test]
fn merge_method_round_trips_every_valid_literal() {
    for (literal, method) in [
        ("merge", MergeMethod::Merge),
        ("squash", MergeMethod::Squash),
        ("rebase", MergeMethod::Rebase),
    ] {
        assert_eq!(MergeMethod::parse(literal), Some(method));
        assert_eq!(method.as_str(), literal);
    }
}

#[test]
fn merge_method_parse_rejects_unknown_literal() {
    assert_eq!(MergeMethod::parse("bogus"), None);
}

fn wire(merge: bool, squash: bool, rebase: bool) -> AllowedMergeMethodsWire {
    AllowedMergeMethodsWire {
        merge_commit_allowed: merge,
        squash_merge_allowed: squash,
        rebase_merge_allowed: rebase,
    }
}

#[test]
fn allowed_merge_methods_from_wire_covers_every_boolean_combination_in_order() {
    // Order is always merge/squash/rebase, matching the function's own `if`/`if`/`if` sequence,
    // regardless of which booleans are set.
    let cases: [(bool, bool, bool, &[MergeMethod]); 8] = [
        (false, false, false, &[]),
        (true, false, false, &[MergeMethod::Merge]),
        (false, true, false, &[MergeMethod::Squash]),
        (false, false, true, &[MergeMethod::Rebase]),
        (
            true,
            true,
            false,
            &[MergeMethod::Merge, MergeMethod::Squash],
        ),
        (
            true,
            false,
            true,
            &[MergeMethod::Merge, MergeMethod::Rebase],
        ),
        (
            false,
            true,
            true,
            &[MergeMethod::Squash, MergeMethod::Rebase],
        ),
        (
            true,
            true,
            true,
            &[MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase],
        ),
    ];
    for (merge, squash, rebase, expected) in cases {
        assert_eq!(
            allowed_merge_methods_from_wire(&wire(merge, squash, rebase)),
            expected.to_vec(),
            "merge={merge} squash={squash} rebase={rebase}"
        );
    }
}

fn graphql_str(variables: &[(&str, GraphqlValue<'_>)], key: &str) -> Option<String> {
    variables.iter().find(|(k, _)| *k == key).map(|(_, v)| {
        let GraphqlValue::Str(s) = v else {
            panic!("expected GraphqlValue::Str for {key}");
        };
        (*s).to_string()
    })
}

#[test]
fn build_approve_review_variables_pins_pull_request_id_and_commit_oid() {
    let pinned = PinnedReview {
        pull_request_id: "PR_kwFOAbc",
        head_sha: "deadbeef",
    };
    let variables = build_approve_review_variables(&pinned, None);

    assert_eq!(
        graphql_str(&variables, "pullRequestId"),
        Some("PR_kwFOAbc".to_string())
    );
    assert_eq!(
        graphql_str(&variables, "commitOID"),
        Some("deadbeef".to_string())
    );
    assert_eq!(
        graphql_str(&variables, "event"),
        Some("APPROVE".to_string())
    );
    assert_eq!(graphql_str(&variables, "body"), None);
}

#[test]
fn build_approve_review_variables_includes_body_when_present() {
    let pinned = PinnedReview {
        pull_request_id: "PR_kwFOAbc",
        head_sha: "deadbeef",
    };
    let variables = build_approve_review_variables(&pinned, Some("Looks good."));

    assert_eq!(
        graphql_str(&variables, "body"),
        Some("Looks good.".to_string())
    );
}

#[test]
fn build_review_argv_approve_has_no_body_flag_without_a_body() {
    let args = build_review_argv(42, "octocat/refract", ReviewVerdict::Approve, None);
    assert_eq!(
        args,
        vec![
            "pr",
            "review",
            "42",
            "--repo",
            "octocat/refract",
            "--approve"
        ]
    );
}

#[test]
fn build_review_argv_comment_includes_body_flag_and_text() {
    let args = build_review_argv(
        42,
        "octocat/refract",
        ReviewVerdict::Comment,
        Some("Nice work."),
    );
    assert_eq!(
        args,
        vec![
            "pr",
            "review",
            "42",
            "--repo",
            "octocat/refract",
            "--comment",
            "--body",
            "Nice work.",
        ]
    );
}

#[test]
fn build_review_argv_request_changes_uses_the_right_flag() {
    let args = build_review_argv(7, "octocat/refract", ReviewVerdict::RequestChanges, None);
    assert_eq!(
        args,
        vec![
            "pr",
            "review",
            "7",
            "--repo",
            "octocat/refract",
            "--request-changes",
        ]
    );
}

#[test]
fn build_merge_argv_always_includes_match_head_commit_with_the_exact_sha() {
    for (method, flag) in [
        (MergeMethod::Merge, "--merge"),
        (MergeMethod::Squash, "--squash"),
        (MergeMethod::Rebase, "--rebase"),
    ] {
        let args = build_merge_argv(42, "octocat/refract", method, "cafef00d");
        assert_eq!(
            args,
            vec![
                "pr",
                "merge",
                "42",
                "--repo",
                "octocat/refract",
                flag,
                "--match-head-commit",
                "cafef00d",
            ]
        );
    }
}

#[test]
fn classify_merge_failure_reads_a_conflict_shaped_stderr_as_not_mergeable() {
    let error = classify_merge_failure("Pull Request is not mergeable", "");
    assert_eq!(error.code, GhErrorCode::NotMergeable);
    assert_eq!(error.message, "Pull Request is not mergeable");
}

#[test]
fn classify_merge_failure_falls_back_to_shared_gh_failure_classification() {
    let error = classify_merge_failure("not logged into any GitHub hosts", "");
    assert_eq!(error.code, GhErrorCode::GhUnavailable);
}

#[test]
fn classify_merge_failure_redacts_a_github_token_found_in_stderr() {
    // Split across fragments (same convention as `omp/redact_tests.rs`) so no single literal
    // in this source file reads as a real live credential.
    let token = format!("{}{}", "ghp_", "1234567890abcdef");
    let stderr = format!("merge conflict with {token}");
    let error = classify_merge_failure(&stderr, "");
    assert_eq!(error.code, GhErrorCode::NotMergeable);
    assert!(!error.message.contains(&token));
}

#[test]
fn allowed_merge_methods_wire_deserializes_a_non_trivial_combination() {
    // Shaped like `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`.
    let json = r#"{
        "mergeCommitAllowed": false,
        "squashMergeAllowed": true,
        "rebaseMergeAllowed": false
    }"#;
    let wire: AllowedMergeMethodsWire = serde_json::from_str(json).unwrap();
    assert!(!wire.merge_commit_allowed);
    assert!(wire.squash_merge_allowed);
    assert!(!wire.rebase_merge_allowed);
}

#[test]
fn threads_and_timeline_envelope_deserializes_the_real_graphql_shape() {
    // Shaped like the real `get_review_threads_and_timeline` GraphQL envelope
    // (`THREADS_AND_TIMELINE_QUERY`'s own selection set): a review thread with `line: null`
    // (a file-level comment), a timeline `IssueComment` node with `author: null` (a deleted
    // account), and a pending `PullRequestReview` node (`submittedAt: null`, `state: "PENDING"`)
    // -- `ipc::pull_requests::mapping::build_timeline` (exercised against this same shape in
    // `mapping_tests.rs`, which can see it) drops that last node since `map_review_verdict` has
    // no verdict for `"PENDING"`.
    let json = r#"{
        "repository": {
            "pullRequest": {
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
            }
        }
    }"#;
    let data: ThreadsAndTimelineData = serde_json::from_str(json).unwrap();
    let pull_request = data.repository.pull_request;
    assert_eq!(pull_request.id, "PR_1");
    assert_eq!(pull_request.review_threads.nodes.len(), 1);
    assert_eq!(pull_request.review_threads.nodes[0].line, None);
    assert_eq!(pull_request.review_threads.nodes[0].path, "src/lib.rs");
    assert_eq!(pull_request.timeline_items.nodes.len(), 2);
    assert!(pull_request.timeline_items.nodes[0].author.is_none());
    assert_eq!(
        pull_request.timeline_items.nodes[1].state.as_deref(),
        Some("PENDING")
    );
    assert_eq!(pull_request.timeline_items.nodes[1].submitted_at, None);
}
