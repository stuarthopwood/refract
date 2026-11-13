use super::*;

fn session(id: &str, parent: Option<&str>) -> Session {
    Session {
        id: id.to_string(),
        repository_id: "repo".to_string(),
        name: id.to_string(),
        branch: id.to_string(),
        base_branch: "main".to_string(),
        worktree_path: format!("C:/worktrees/{id}"),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
        archived_at: None,
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: parent.map(str::to_string),
    }
}

fn archived(mut s: Session) -> Session {
    s.archived_at = Some("2026-01-02T00:00:00.000Z".to_string());
    s
}

/// `n` live children `c1..cn` under `parent`.
fn with_children(mut rows: Vec<Session>, parent: &str, n: usize) -> Vec<Session> {
    rows.extend((1..=n).map(|i| session(&format!("c{i}"), Some(parent))));
    rows
}

#[test]
fn depth_of_counts_the_parent_chain_from_one() {
    let rows = vec![
        session("a", None),
        session("b", Some("a")),
        session("c", Some("b")),
        session("d", Some("c")),
    ];
    assert_eq!(depth_of(&rows, "a"), 1);
    assert_eq!(depth_of(&rows, "b"), 2);
    assert_eq!(depth_of(&rows, "c"), 3);
    assert_eq!(depth_of(&rows, "d"), 4);
}

#[test]
fn depth_of_a_cyclic_chain_counts_as_a_root() {
    let rows = vec![
        session("a", Some("b")),
        session("b", Some("a")),
        session("c", Some("a")),
    ];
    assert_eq!(depth_of(&rows, "a"), 1);
    assert_eq!(depth_of(&rows, "b"), 1);
    assert_eq!(depth_of(&rows, "c"), 1);
}

#[test]
fn depth_of_a_self_parent_counts_as_a_root() {
    assert_eq!(depth_of(&[session("a", Some("a"))], "a"), 1);
}

#[test]
fn depth_of_a_dangling_parent_counts_as_no_parent() {
    let rows = vec![session("a", Some("gone")), session("b", Some("a"))];
    assert_eq!(depth_of(&rows, "a"), 1);
    assert_eq!(depth_of(&rows, "b"), 2);
}

#[test]
fn live_children_skips_archived_but_counts_stopped_and_hidden() {
    let mut hidden = session("hidden", Some("p"));
    hidden.hidden_at = Some("2026-01-02T00:00:00.000Z".to_string());
    let rows = vec![
        session("p", None),
        session("live", Some("p")),
        hidden,
        archived(session("old", Some("p"))),
        session("other", Some("q")),
    ];
    let ids: Vec<&str> = live_children(&rows, "p").map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["live", "hidden"]);
}

#[test]
fn descendants_walks_every_level_including_archived() {
    let rows = vec![
        session("a", None),
        session("b", Some("a")),
        archived(session("c", Some("b"))),
        session("x", None),
    ];
    assert_eq!(descendants(&rows, "a"), ["b", "c"]);
    assert!(descendants(&rows, "c").is_empty());
}

#[test]
fn descendants_terminates_on_a_cycle_and_excludes_the_start() {
    let rows = vec![session("a", Some("b")), session("b", Some("a"))];
    assert_eq!(descendants(&rows, "a"), ["b"]);
}

#[test]
fn in_tree_is_the_session_and_its_descendants_only() {
    let rows = vec![
        session("a", None),
        session("b", Some("a")),
        session("c", Some("b")),
        session("sib", None),
        session("up", None),
    ];
    assert!(in_tree(&rows, "b", "b"));
    assert!(in_tree(&rows, "b", "c"));
    assert!(!in_tree(&rows, "b", "a"));
    assert!(!in_tree(&rows, "b", "sib"));
}

#[test]
fn in_tree_ignores_a_dangling_link() {
    let rows = vec![session("a", None), session("orphan", Some("gone"))];
    assert!(!in_tree(&rows, "a", "orphan"));
}

#[test]
fn a_new_session_under_a_depth_one_or_two_parent_is_allowed() {
    let rows = vec![session("a", None), session("b", Some("a"))];
    assert_eq!(validate_parent(&rows, None, "a"), Ok(()));
    assert_eq!(validate_parent(&rows, None, "b"), Ok(()));
}

#[test]
fn a_new_session_under_a_depth_three_parent_is_depth_limit() {
    let rows = vec![
        session("a", None),
        session("b", Some("a")),
        session("c", Some("b")),
    ];
    assert_eq!(
        validate_parent(&rows, None, "c"),
        Err(TreeError::DepthLimit)
    );
}

#[test]
fn the_fourth_live_child_is_allowed_and_the_fifth_is_child_limit() {
    let three = with_children(vec![session("p", None)], "p", 3);
    assert_eq!(validate_parent(&three, None, "p"), Ok(()));
    let four = with_children(vec![session("p", None)], "p", 4);
    assert_eq!(
        validate_parent(&four, None, "p"),
        Err(TreeError::ChildLimit)
    );
}

#[test]
fn archived_children_do_not_count_toward_the_limit_but_stopped_and_hidden_do() {
    let mut rows = with_children(vec![session("p", None)], "p", 3);
    rows.push(archived(session("old", Some("p"))));
    assert_eq!(validate_parent(&rows, None, "p"), Ok(()));

    let mut hidden = session("hidden", Some("p"));
    hidden.hidden_at = Some("2026-01-02T00:00:00.000Z".to_string());
    let mut rows = with_children(vec![session("p", None)], "p", 3);
    rows.push(hidden);
    assert_eq!(
        validate_parent(&rows, None, "p"),
        Err(TreeError::ChildLimit)
    );
}

#[test]
fn a_session_may_not_be_its_own_parent() {
    let rows = vec![session("a", None)];
    assert_eq!(
        validate_parent(&rows, Some("a"), "a"),
        Err(TreeError::InvalidParent)
    );
}

#[test]
fn a_descendant_may_not_become_the_parent() {
    let rows = vec![
        session("a", None),
        session("b", Some("a")),
        session("c", Some("b")),
    ];
    assert_eq!(
        validate_parent(&rows, Some("a"), "b"),
        Err(TreeError::InvalidParent)
    );
    assert_eq!(
        validate_parent(&rows, Some("a"), "c"),
        Err(TreeError::InvalidParent)
    );
}

#[test]
fn a_move_that_puts_a_deeper_descendant_past_depth_three_is_depth_limit() {
    // Moving `m` (with child `n`) under `p2` (depth 2) would put `n` at depth 4.
    let rows = vec![
        session("p1", None),
        session("p2", Some("p1")),
        session("m", None),
        session("n", Some("m")),
    ];
    assert_eq!(
        validate_parent(&rows, Some("m"), "p2"),
        Err(TreeError::DepthLimit)
    );
    // The same move under a depth-1 parent keeps `n` at depth 3.
    assert_eq!(validate_parent(&rows, Some("m"), "p1"), Ok(()));
}

#[test]
fn moving_a_session_under_its_current_parent_does_not_count_it_twice() {
    let rows = with_children(vec![session("p", None)], "p", 4);
    assert_eq!(validate_parent(&rows, Some("c1"), "p"), Ok(()));
}

#[test]
fn moving_into_a_full_parent_is_child_limit_but_an_archived_mover_is_not_counted() {
    let mut rows = with_children(vec![session("p", None)], "p", 4);
    rows.push(session("m", None));
    assert_eq!(
        validate_parent(&rows, Some("m"), "p"),
        Err(TreeError::ChildLimit)
    );

    let mut rows = with_children(vec![session("p", None)], "p", 4);
    rows.push(archived(session("m", None)));
    assert_eq!(validate_parent(&rows, Some("m"), "p"), Ok(()));
}
