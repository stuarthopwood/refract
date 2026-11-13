use super::*;

fn repos() -> Vec<(String, String)> {
    vec![
        ("r1".into(), "Refract".into()),
        ("r2".into(), "Other".into()),
    ]
}

fn s(id: &str, repo: &str, status: &str, at: &str) -> Value {
    json!({
        "id": id, "name": format!("name-{id}"), "repositoryId": repo, "branch": format!("b-{id}"),
        "status": status, "archivedAt": null, "lastActivityAt": at
    })
}

#[test]
fn status_vocabulary_maps_each_state() {
    assert_eq!(status_of(&json!({"status": "working"})).0, "working");
    assert_eq!(
        status_of(&json!({"status": "needs-you"})).0,
        "waiting-for-approval"
    );
    assert_eq!(status_of(&json!({"status": "idle"})).0, "idle");
    assert_eq!(
        status_of(&json!({"status": "idle", "pause": "paused"})).0,
        "paused"
    );
    assert_eq!(
        status_of(&json!({"status": "working", "pause": "pausing"})).0,
        "working"
    );
    assert_eq!(
        status_of(&json!({"status": "stopped", "pause": "paused"})).0,
        "paused"
    );
}

#[test]
fn stopped_carries_its_reason() {
    for reason in [
        "agent-exited",
        "start-failed",
        "worktree-missing",
        "not-started",
    ] {
        let row = json!({"status": "stopped", "stopReason": reason});
        assert_eq!(status_of(&row), ("stopped", Some(reason)));
    }
}

#[test]
fn stop_on_request_wins_over_not_started() {
    let row = json!({
        "status": "stopped", "stopReason": "not-started", "stoppedOnRequestConversation": "c1"
    });
    assert_eq!(status_of(&row), ("stopped", Some("stopped-on-request")));
}

#[test]
fn unknown_stop_reason_reads_as_agent_exited() {
    let row = json!({"status": "stopped", "stopReason": "weird"});
    assert_eq!(status_of(&row).1, Some("agent-exited"));
}

#[test]
fn list_leaves_archived_out_unless_asked() {
    let mut archived = s("a", "r1", "idle", "2026-01-01");
    archived["archivedAt"] = "2026-01-02".into();
    let all = [archived, s("b", "r1", "idle", "2026-01-03")];
    let plain = list_value(&all, &repos(), "x", None, false).unwrap();
    assert_eq!(plain["total"], 1);
    let with = list_value(&all, &repos(), "x", None, true).unwrap();
    assert_eq!(with["total"], 2);
    assert_eq!(with["sessions"][1]["archived"], true);
}

#[test]
fn list_filters_by_project_id_or_name_and_rejects_unknown() {
    let all = [s("a", "r1", "idle", "1"), s("b", "r2", "idle", "2")];
    for key in ["r2", "other"] {
        let out = list_value(&all, &repos(), "x", Some(key), false).unwrap();
        assert_eq!(out["total"], 1);
        assert_eq!(out["sessions"][0]["id"], "b");
    }
    let err = list_value(&all, &repos(), "x", Some("nope"), false).unwrap_err();
    assert_eq!(err.code, UNKNOWN_PROJECT);
}

#[test]
fn list_marks_self_and_hidden_and_sorts_newest_first() {
    let mut hidden = s("h", "r1", "idle", "2026-01-01");
    hidden["hiddenAt"] = "t".into();
    let all = [hidden, s("me", "r1", "working", "2026-02-01")];
    let out = list_value(&all, &repos(), "me", None, false).unwrap();
    assert_eq!(out["sessions"][0]["id"], "me");
    assert_eq!(out["sessions"][0]["self"], true);
    assert_eq!(out["sessions"][1]["hidden"], true);
    assert!(out["sessions"][1].get("self").is_none());
    assert!(out["sessions"][0].get("pullRequest").is_none());
}

#[test]
fn list_trim_keeps_the_callers_row_and_reports_truncation() {
    let mut all: Vec<Value> = (0..200)
        .map(|i| {
            s(
                &format!("s{i:03}"),
                "r1",
                "idle",
                &format!("2026-03-{:02}", 1 + i % 28),
            )
        })
        .collect();
    all.push(s("me", "r1", "idle", "2000-01-01"));
    let out = list_value(&all, &repos(), "me", None, false).unwrap();
    assert!(out.to_string().len() <= MAX_RESULT_BYTES);
    assert_eq!(out["truncated"], true);
    assert_eq!(out["total"], 201);
    assert!(out["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "me" && r["self"] == true));
}

#[test]
fn status_value_has_reason_only_when_stopped_and_passes_the_pr_through() {
    let running = status_value(
        &s("a", "r1", "idle", "t"),
        &repos(),
        json!({"number": 7, "url": "u"}),
    );
    assert!(running.get("stopReason").is_none());
    assert_eq!(running["pullRequest"]["number"], 7);
    assert_eq!(running["project"]["name"], "Refract");
    let mut stopped = s("b", "r1", "stopped", "t");
    stopped["stopReason"] = "agent-exited".into();
    let out = status_value(&stopped, &repos(), Value::Null);
    assert_eq!(out["stopReason"], "agent-exited");
    assert!(out["pullRequest"].is_null());
}

#[test]
fn parent_id_is_on_list_rows_and_status_only_when_set() {
    let mut child = s("kid", "r1", "idle", "t");
    child["parentSessionId"] = "mum".into();
    let all = [child.clone(), s("mum", "r1", "idle", "t")];
    let listed = list_value(&all, &repos(), "mum", None, false).unwrap();
    let rows = listed["sessions"].as_array().unwrap();
    let find = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(find("kid")["parentId"], "mum");
    assert!(find("mum").get("parentId").is_none());
    assert_eq!(status_value(&child, &repos(), Value::Null)["parentId"], "mum");
    let root = status_value(&s("mum", "r1", "idle", "t"), &repos(), Value::Null);
    assert!(root.get("parentId").is_none());
}

#[test]
fn the_create_and_update_tools_are_checked_against_their_own_schemas() {
    for tool in [CREATE_SESSION, UPDATE_SESSION] {
        assert!(is_session_tool(tool), "{tool}");
        assert!(!description(tool).is_empty(), "{tool}");
        let err = check_args(tool, &json!({ "bogus": 1 })).unwrap_err();
        assert_eq!(err.code, INVALID_INPUT, "{tool}");
    }
    assert!(check_args(CREATE_SESSION, &json!({ "prompt": "go" })).is_ok());
}

#[test]
fn unknown_arguments_are_invalid_input() {
    assert_eq!(
        check_args(LIST_SESSIONS, &json!({"bogus": 1}))
            .unwrap_err()
            .code,
        INVALID_INPUT
    );
    assert_eq!(
        check_args(GET_SESSION_STATUS, &json!({})).unwrap_err().code,
        INVALID_INPUT
    );
    assert!(check_args(LIST_SESSIONS, &json!({"include_archived": true})).is_ok());
}

#[test]
fn wrong_typed_arguments_are_invalid_input() {
    for (tool, args) in [
        (LIST_SESSIONS, json!({"project": 5})),
        (LIST_SESSIONS, json!({"include_archived": "yes"})),
        (LIST_SESSIONS, json!([])),
        (GET_SESSION_STATUS, json!({"id": 7})),
        (SEND_SESSION_MESSAGE, json!({"id": "a", "text": 1})),
    ] {
        assert_eq!(
            check_args(tool, &args).unwrap_err().code,
            INVALID_INPUT,
            "{args}"
        );
    }
}

#[test]
fn the_send_description_tells_the_model_the_message_is_peer_input() {
    let text = description(SEND_SESSION_MESSAGE);
    assert!(text.contains("own approval mode"));
    assert!(text.contains("peer Session, not from the developer"));
}
