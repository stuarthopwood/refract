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
            "api",
            "--method",
            "GET",
            "search/issues",
            "-f",
            "q=repo:a/b is:open",
            "-f",
            "per_page=10",
            "-f",
            "sort=updated",
            "-f",
            "order=desc"
        ]
    );
}

#[test]
fn search_args_for_a_term_have_no_sort_or_order() {
    assert_eq!(
        search_args(&slug(), "login"),
        [
            "api",
            "--method",
            "GET",
            "search/issues",
            "-f",
            "q=repo:a/b in:title login",
            "-f",
            "per_page=10"
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
