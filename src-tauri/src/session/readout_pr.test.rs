use super::*;

fn found() -> PullRequestLookup {
    PullRequestLookup::Found(PullRequestState {
        number: 7,
        url: "https://github.com/o/r/pull/7".to_string(),
        state: "open",
        checks: None,
        linked_issues: Vec::new(),
    })
}

#[test]
fn a_found_pull_request_becomes_its_json() {
    let value = found().into_json();
    assert_eq!(value["number"], 7);
    assert_eq!(value["url"], "https://github.com/o/r/pull/7");
}

#[test]
fn no_pull_request_and_an_unavailable_lookup_are_null() {
    assert_eq!(PullRequestLookup::None.into_json(), Value::Null);
    assert_eq!(PullRequestLookup::Unavailable.into_json(), Value::Null);
}

#[test]
fn a_none_answer_for_the_link_is_remembered_without_blocking_the_readout_poll() {
    let repo = Path::new("link-backoff-test-repo");
    let link = link_key(repo, "feat/x");
    let poll = (repo.to_string_lossy().into_owned(), "feat/x".to_string());
    assert!(!backed_off(&link));
    back_off(link.clone());
    assert!(backed_off(&link));
    assert!(!backed_off(&poll));
}

#[test]
fn the_link_backoff_holds_until_exactly_sixty_seconds_then_clears() {
    let link = link_key(Path::new("link-backoff-edge-repo"), "feat/y");
    let t0 = Instant::now();
    back_off_at(link.clone(), t0);
    assert!(backed_off_at(&link, t0 + Duration::from_secs(59)));
    assert!(!backed_off_at(&link, t0 + Duration::from_secs(60)));
}
