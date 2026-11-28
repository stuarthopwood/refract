use super::*;
use crate::git::test_support::{init_repo, run_git};

#[test]
fn a_cached_pull_request_is_used_without_a_lookup() {
    let cached = json!({ "number": 7, "url": "https://github.com/o/r/pull/7" });
    assert_eq!(pr_source(cached.clone()), PrSource::Cached(cached));
}

#[test]
fn a_null_cache_falls_through_to_a_lookup() {
    assert_eq!(pr_source(Value::Null), PrSource::Lookup);
}

#[test]
fn the_link_keeps_only_number_and_url() {
    let pr = json!({ "number": 7, "url": "u", "state": "open", "checks": "passing" });
    assert_eq!(link_of(&pr), json!({ "number": 7, "url": "u" }));
}

#[test]
fn a_value_without_number_and_url_is_no_link() {
    assert_eq!(link_of(&Value::Null), Value::Null);
    assert_eq!(link_of(&json!({ "number": 7 })), Value::Null);
    assert_eq!(link_of(&json!({ "url": "u" })), Value::Null);
}

#[test]
fn the_readout_carries_the_subagent_count_it_is_given() {
    let count = json!({ "running": 0, "finished": 0, "exited": 0, "failed": 2, "cancelled": 0 });
    let readout = build_readout_value(
        &State::default(),
        Value::Null,
        Value::Null,
        Some(count.clone()),
    );
    assert_eq!(readout["subagentCount"], count);
}

#[test]
fn the_readout_has_a_null_subagent_count_when_the_pill_is_hidden() {
    let readout = build_readout_value(&State::default(), Value::Null, Value::Null, None);
    assert_eq!(readout["subagentCount"], Value::Null);
}

#[tokio::test]
async fn an_uncommitted_file_with_no_commits_ahead_counts_as_one_file() {
    let repo = init_repo().await;
    tokio::fs::write(repo.join("new.txt"), "a\n").await.unwrap();

    let stat = working_tree_stat(&repo, "main").await.expect("readable");

    assert_eq!((stat.files, stat.additions), (1, 1));
}

#[tokio::test]
async fn a_clean_tree_with_a_commit_ahead_reads_zero_files() {
    let repo = init_repo().await;
    run_git(&repo, &["checkout", "-q", "-b", "feature"]).await;
    tokio::fs::write(repo.join("done.txt"), "a\n").await.unwrap();
    run_git(&repo, &["add", "."]).await;
    run_git(&repo, &["commit", "-q", "-m", "ahead"]).await;

    let stat = working_tree_stat(&repo, "main").await.expect("readable");

    assert_eq!(stat.files, 0);
    assert!(!stat.partial);
}

#[tokio::test]
async fn an_unreadable_worktree_has_no_stat() {
    let missing = crate::test_scratch::path(format!("refract-no-worktree-{}", uuid::Uuid::new_v4()));

    assert!(working_tree_stat(&missing, "main").await.is_none());
}
