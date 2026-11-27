use std::time::Duration;

use serde_json::json;

use super::*;
use crate::agent_tools::sessions_end::EndTool;
use crate::agent_tools::{sessions_create, sessions_update};

fn code(result: Result<Plan, ToolError>) -> String {
    result.unwrap_err().code
}

#[test]
fn list_takes_no_arguments() {
    assert_eq!(plan(LIST_PANELS, &json!({})), Ok(Plan::List));
    assert_eq!(code(plan(LIST_PANELS, &json!({ "x": 1 }))), INVALID_INPUT);
}

#[test]
fn session_tools_plan_as_native_and_never_mutate() {
    let calls = [
        (sessions::LIST_SESSIONS, json!({})),
        (sessions::GET_SESSION_STATUS, json!({ "id": "s1" })),
        (
            sessions::SEND_SESSION_MESSAGE,
            json!({ "id": "s1", "text": "hi" }),
        ),
    ];
    for (tool, args) in calls {
        let planned = plan(tool, &args).unwrap();
        assert_eq!(
            planned,
            Plan::Native {
                tool: tool.to_string(),
                args: args.clone()
            }
        );
        assert!(!planned.mutates(), "{tool}");
        assert_eq!(planned.event_args(), args);
    }
}

#[test]
fn session_tools_reject_bad_arguments_as_invalid_input() {
    let calls = [
        (sessions::LIST_SESSIONS, json!({ "project": 5 })),
        (sessions::LIST_SESSIONS, json!({ "bogus": true })),
        (sessions::GET_SESSION_STATUS, json!({})),
        (sessions::SEND_SESSION_MESSAGE, json!({ "id": "s1" })),
    ];
    for (tool, args) in calls {
        assert_eq!(code(plan(tool, &args)), INVALID_INPUT, "{tool}");
    }
}

#[test]
fn create_and_update_plan_as_native_with_their_own_schemas() {
    for (tool, ok, bad) in [
        (
            sessions_create::CREATE_SESSION,
            json!({ "prompt": "go" }),
            json!({ "prompt": "go", "bogus": 1 }),
        ),
        (
            sessions_update::UPDATE_SESSION,
            json!({ "id": "s1", "name": "n" }),
            json!({ "name": "n" }),
        ),
    ] {
        let planned = plan(tool, &ok).unwrap();
        assert!(matches!(planned, Plan::Native { .. }), "{tool}");
        assert!(!planned.mutates(), "{tool}");
        assert_eq!(code(plan(tool, &bad)), INVALID_INPUT, "{tool}");
    }
}

/// The manager stays alive, so a call that fell through to `send_session_message` would fail
/// on its own `id`/`text` arguments instead of the tool's own `prompt`/`nothing to change`.
#[tokio::test]
async fn create_and_update_are_dispatched_to_their_own_tools() {
    let dir = crate::test_scratch::path(format!("refract-router-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir)
            .await
            .unwrap(),
    ));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    let agent = manager.get_or_create_agent("caller");
    for (tool, args, expected) in [
        (sessions_create::CREATE_SESSION, json!({}), "prompt"),
        (
            sessions_update::UPDATE_SESSION,
            json!({ "id": "x" }),
            "nothing to change",
        ),
    ] {
        let err = run_native(&agent, "call-1", tool, &args).await.unwrap_err();
        assert_eq!(err.code, INVALID_INPUT, "{tool}");
        assert!(err.message.contains(expected), "{tool}: {}", err.message);
    }
}

#[test]
fn end_tools_plan_as_native_and_reject_bad_arguments() {
    for tool in EndTool::ALL {
        let name = tool.name();
        let planned = plan(name, &json!({ "id": "s1" })).unwrap();
        assert!(matches!(planned, Plan::Native { .. }), "{name}");
        assert_eq!(code(plan(name, &json!({}))), INVALID_INPUT, "{name}");
        assert_eq!(
            code(plan(name, &json!({ "id": "s1", "bogus": 1 }))),
            INVALID_INPUT,
            "{name}"
        );
    }
    assert_eq!(
        code(plan("refract_nuke_session", &json!({ "id": "s1" }))),
        UNKNOWN_TOOL
    );
}

/// The caller has no row, so a call that reached the end tool stops at the caller check rather
/// than falling through to `send_session_message`'s own `text` argument error.
#[tokio::test]
async fn end_tools_are_dispatched_to_their_own_handler() {
    let dir = crate::test_scratch::path(format!("refract-router-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir)
            .await
            .unwrap(),
    ));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    let agent = manager.get_or_create_agent("caller");
    for tool in EndTool::ALL {
        let err = run_native(&agent, "call-1", tool.name(), &json!({ "id": "x" }))
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::agent_tools::router::CANCELLED,
            "{}",
            tool.name()
        );
        assert!(err.message.contains("calling Session"), "{}", err.message);
    }
}

/// An agent whose manager was dropped: the app is quitting.
pub(crate) async fn agent_of_a_dropped_manager() -> Arc<SessionAgent> {
    let dir = crate::test_scratch::path(format!("refract-router-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir)
            .await
            .unwrap(),
    ));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    manager.get_or_create_agent("caller")
}

/// A shutting-down caller reads as `cancelled`, never as a failed create.
#[tokio::test]
async fn create_from_a_shutting_down_caller_is_cancelled() {
    let agent = agent_of_a_dropped_manager().await;
    let args = json!({ "prompt": "hi" });
    let err = sessions_create::create(&agent, "call-1", &args)
        .await
        .unwrap_err();
    assert_eq!(err.code, CANCELLED);
}

/// A shutting-down caller reads as `cancelled`, never as a failed update.
#[tokio::test]
async fn update_from_a_shutting_down_caller_is_cancelled() {
    let agent = agent_of_a_dropped_manager().await;
    let args = json!({ "id": "x", "name": "n" });
    let err = sessions_update::update(&agent, "call-1", &args)
        .await
        .unwrap_err();
    assert_eq!(err.code, CANCELLED);
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

/// A late click on a card whose call already ended (timed out or cancelled) must not apply.
#[tokio::test]
async fn an_approval_answered_after_its_call_finished_is_refused() {
    let router = ToolRouter::default();
    let _cancel = router.begin("c1").unwrap();
    let rx = router.wait_for(&approval::request_id("c1"));

    router.finish("c1");

    assert!(!router.answer_approval("refract-tool-c1", Decision::Approved));
    assert!(rx.await.is_err());
}

#[tokio::test]
async fn a_second_click_on_an_approval_card_is_refused_and_the_first_decision_stands() {
    let router = ToolRouter::default();
    let rx = router.wait_for(&approval::request_id("c1"));

    assert!(router.answer_approval("refract-tool-c1", Decision::Denied));
    assert!(!router.answer_approval("refract-tool-c1", Decision::Approved));

    assert!(matches!(rx.await, Ok(Reply::Approval(Decision::Denied))));
}

#[tokio::test]
async fn an_approval_for_an_unknown_request_or_a_dropped_waiter_is_refused() {
    let router = ToolRouter::default();
    assert!(!router.answer_approval("refract-tool-missing", Decision::Approved));

    drop(router.wait_for("refract-tool-c2"));
    assert!(!router.answer_approval("refract-tool-c2", Decision::Approved));
}

#[tokio::test]
async fn an_approval_card_answer_never_completes_another_calls_wait() {
    let router = ToolRouter::default();
    let mut other = router.wait_for(&approval::request_id("c2"));
    let _rx = router.wait_for(&approval::request_id("c1"));

    assert!(router.answer_approval("refract-tool-c1", Decision::Approved));

    assert!(other.try_recv().is_err());
    assert!(router.answer_approval("refract-tool-c2", Decision::Denied));
}

#[test]
fn each_approval_decision_maps_to_its_outcome() {
    assert!(approval_outcome(Some(Reply::Approval(Decision::Approved))).is_ok());
    assert_eq!(
        approval_outcome(Some(Reply::Approval(Decision::Denied)))
            .unwrap_err()
            .code,
        DENIED
    );
    for reply in [
        None,
        Some(Reply::Ask(None)),
        Some(Reply::Renderer(Ok(json!(1)))),
    ] {
        assert_eq!(approval_outcome(reply).unwrap_err().code, CANCELLED);
    }
}

#[tokio::test]
async fn drop_all_frees_waits_and_wakes_cancels() {
    let router = ToolRouter::default();
    let cancel = router.begin("c1").unwrap();
    let rx = router.wait_for("c1");
    router.drop_all();
    assert!(rx.await.is_err());
    cancel.notified().await;
    assert!(router.lock().waits.is_empty() && router.lock().cancels.is_empty());
}

#[tokio::test]
async fn cancel_frame_wakes_only_the_target() {
    let router = ToolRouter::default();
    let target = router.begin("c1").unwrap();
    let other = router.begin("c2").unwrap();
    router.handle_cancel(&json!({ "type": "host_tool_cancel", "id": "x", "targetId": "c1" }));
    target.notified().await;
    let woke = tokio::time::timeout(Duration::from_millis(20), other.notified()).await;
    assert!(woke.is_err());
}

#[test]
fn a_pending_call_id_is_not_begun_twice() {
    let router = ToolRouter::default();
    assert!(router.begin("c1").is_some());
    assert!(router.begin("c1").is_none());
}

#[test]
fn an_answer_through_another_router_is_not_accepted() {
    let a = ToolRouter::default();
    let b = ToolRouter::default();
    let _rx = a.wait_for("c1");
    assert!(!b.answer("c1", &json!({ "ok": true, "value": 1 })));
    assert!(a.answer("c1", &json!({ "ok": true, "value": 1 })));
}

#[test]
fn an_ask_answer_reaches_a_waiting_call_once() {
    let router = ToolRouter::default();
    let rx = router.wait_for("c1");
    assert!(router.answer_ask("c1", None));
    assert!(matches!(rx.blocking_recv(), Ok(Reply::Ask(None))));
    assert!(!router.answer_ask("c1", None));
}

#[test]
fn an_ask_answer_for_a_gone_call_reports_false() {
    let router = ToolRouter::default();
    assert!(!router.answer_ask("missing", None));
    let rx = router.wait_for("c2");
    drop(rx);
    assert!(!router.answer_ask("c2", None));
}

#[test]
fn a_cancelled_approval_becomes_an_error_frame() {
    let err = approval_outcome(Some(Reply::Approval(Decision::Cancelled))).unwrap_err();
    let frame = error_frame("c1", &err);
    assert_eq!(frame["isError"], true);
    assert_eq!(err.code, CANCELLED);
}
