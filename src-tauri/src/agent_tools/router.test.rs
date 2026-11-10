use serde_json::json;

use super::*;

fn code(result: Result<Plan, ToolError>) -> String {
    result.unwrap_err().code
}

#[test]
fn list_takes_no_arguments() {
    assert_eq!(plan(LIST_PANELS, &json!({})), Ok(Plan::List));
    assert_eq!(code(plan(LIST_PANELS, &json!({ "x": 1 }))), INVALID_INPUT);
}

#[test]
fn unknown_tool_panel_and_action_get_their_codes() {
    assert_eq!(code(plan("refract_nope", &json!({}))), UNKNOWN_TOOL);
    assert_eq!(
        code(plan(OPEN_PANEL, &json!({ "panelId": "nope" }))),
        UNKNOWN_PANEL
    );
    assert_eq!(
        code(plan(
            INVOKE_PANEL_ACTION,
            &json!({ "panelId": "git-changes", "action": "nope" })
        )),
        UNKNOWN_ACTION
    );
}

#[test]
fn open_validates_the_panel_open_input() {
    let ok = plan(
        OPEN_PANEL,
        &json!({ "panelId": "git-changes", "input": { "path": "src/a.ts" } }),
    );
    assert!(matches!(ok, Ok(Plan::Open { .. })));
    assert_eq!(
        code(plan(
            OPEN_PANEL,
            &json!({ "panelId": "git-changes", "input": { "path": "../x" } })
        )),
        INVALID_INPUT
    );
    assert_eq!(
        code(plan(
            OPEN_PANEL,
            &json!({ "panelId": "outline", "input": { "a": 1 } })
        )),
        INVALID_INPUT
    );
    assert!(plan(OPEN_PANEL, &json!({ "panelId": "outline" })).is_ok());
}

#[test]
fn invoke_carries_the_mutates_flag_from_the_contract() {
    let stage = plan(
        INVOKE_PANEL_ACTION,
        &json!({ "panelId": "git-changes", "action": "stage_file", "input": { "path": "a.ts" } }),
    )
    .unwrap();
    assert!(stage.mutates());
    let show = plan(
        INVOKE_PANEL_ACTION,
        &json!({ "panelId": "git-changes", "action": "show_file", "input": { "path": "a.ts" } }),
    )
    .unwrap();
    assert!(!show.mutates());
}

#[test]
fn invoke_rejects_bad_input_and_extra_arguments() {
    assert_eq!(
        code(plan(
            INVOKE_PANEL_ACTION,
            &json!({ "panelId": "git-changes", "action": "stage_file", "input": {} })
        )),
        INVALID_INPUT
    );
    assert_eq!(
        code(plan(
            INVOKE_PANEL_ACTION,
            &json!({ "panelId": "git-changes", "action": "stage_file", "sessionId": "other" })
        )),
        INVALID_INPUT
    );
}

#[test]
fn ok_frame_wraps_text_content() {
    let frame = ok_frame("c1", &json!({ "panels": [] }));
    assert_eq!(frame["type"], "host_tool_result");
    assert_eq!(frame["id"], "c1");
    assert_eq!(frame["result"]["content"][0]["text"], "{\"panels\":[]}");
    assert!(frame.get("isError").is_none());
}

#[test]
fn oversized_results_become_result_too_large() {
    let frame = ok_frame("c1", &json!("x".repeat(MAX_RESULT_BYTES + 1)));
    assert_eq!(frame["isError"], true);
    let text = frame["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains(RESULT_TOO_LARGE));
}

#[test]
fn error_frames_set_is_error_and_carry_code_and_message() {
    let frame = error_frame("c1", &ToolError::new(DENIED, "no"));
    assert_eq!(frame["isError"], true);
    assert_eq!(frame["result"]["isError"], true);
    let text: Value =
        serde_json::from_str(frame["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["error"]["code"], DENIED);
    assert_eq!(text["error"]["message"], "no");
}

#[test]
fn replies_parse_to_value_or_error() {
    assert_eq!(
        parse_reply(&json!({ "ok": true, "value": { "a": 1 } })),
        Ok(json!({ "a": 1 }))
    );
    let err = parse_reply(
        &json!({ "ok": false, "error": { "code": "panel_unavailable", "message": "m" } }),
    )
    .unwrap_err();
    assert_eq!(err, ToolError::new("panel_unavailable", "m"));
    assert!(parse_reply(&json!({})).is_err());
}

#[test]
fn calls_parse_from_the_wire_frame() {
    let call = parse_call(&json!({
        "type": "host_tool_call", "id": "h1", "toolCallId": "t1",
        "toolName": "refract_list_panels", "arguments": {}
    }))
    .unwrap();
    assert_eq!(
        (call.id.as_str(), call.tool.as_str()),
        ("h1", "refract_list_panels")
    );
    assert!(parse_call(&json!({ "type": "host_tool_call" })).is_none());
}

#[tokio::test]
async fn first_renderer_answer_wins_and_later_ones_drop() {
    let router = ToolRouter::default();
    let rx = router.wait_for("c1");
    assert!(router.answer("c1", &json!({ "ok": true, "value": 1 })));
    assert!(!router.answer("c1", &json!({ "ok": true, "value": 2 })));
    assert!(matches!(rx.await, Ok(Reply::Renderer(Ok(v))) if v == json!(1)));
}

#[tokio::test]
async fn approval_answers_route_by_request_id() {
    let router = ToolRouter::default();
    let rx = router.wait_for(&approval::request_id("c1"));
    assert!(router.answer_approval("refract-tool-c1", Decision::Denied));
    assert!(matches!(rx.await, Ok(Reply::Approval(Decision::Denied))));
}

#[tokio::test]
async fn drop_all_frees_waits_and_wakes_cancels() {
    let router = ToolRouter::default();
    let cancel = router.begin("c1");
    let rx = router.wait_for("c1");
    router.drop_all();
    assert!(rx.await.is_err());
    cancel.notified().await;
    assert!(router.lock().waits.is_empty() && router.lock().cancels.is_empty());
}

#[tokio::test]
async fn cancel_frame_wakes_only_the_target() {
    let router = ToolRouter::default();
    let target = router.begin("c1");
    let other = router.begin("c2");
    router.handle_cancel(&json!({ "type": "host_tool_cancel", "id": "x", "targetId": "c1" }));
    target.notified().await;
    let woke = tokio::time::timeout(Duration::from_millis(20), other.notified()).await;
    assert!(woke.is_err());
}
