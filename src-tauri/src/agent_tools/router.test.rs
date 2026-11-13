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

/// The manager is dropped, as at shutdown, so only the tool's own entry point can answer
/// `cancelled`; a call that fell through to another tool would say `invalid_input`.
#[tokio::test]
async fn create_and_update_are_dispatched_to_their_own_tools() {
    let dir = crate::test_scratch::path(format!("refract-router-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir).await.unwrap(),
    ));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir).await.unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    let agent = crate::session::manager::SessionManager::new(registry, settings, events)
        .get_or_create_agent("caller");
    for (tool, args) in [
        (sessions_create::CREATE_SESSION, json!({ "prompt": "go" })),
        (sessions_update::UPDATE_SESSION, json!({ "id": "x" })),
    ] {
        let result = run_native(&agent, "call-1", tool, &args).await;
        assert_eq!(code_of(result), CANCELLED, "{tool}");
    }
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

#[tokio::test(start_paused = true)]
async fn a_silent_renderer_times_out_with_the_timeout_code() {
    let router = ToolRouter::default();
    let rx = router.wait_for("c1");
    let wait = tokio::spawn(wait_renderer(rx));
    tokio::time::advance(Duration::from_millis(RENDERER_TIMEOUT_MS + 1)).await;
    assert_eq!(wait.await.unwrap().unwrap_err().code, TIMEOUT);
}

#[tokio::test]
async fn a_cancel_during_a_renderer_wait_returns_cancelled() {
    let router = ToolRouter::default();
    let _cancel = router.begin("c1").unwrap();
    let rx = router.wait_for("c1");
    router.drop_all();
    assert_eq!(wait_renderer(rx).await.unwrap_err().code, CANCELLED);
}

#[test]
fn a_cancelled_approval_becomes_an_error_frame() {
    let err = approval_outcome(Some(Reply::Approval(Decision::Cancelled))).unwrap_err();
    let frame = error_frame("c1", &err);
    assert_eq!(frame["isError"], true);
    assert_eq!(err.code, CANCELLED);
}

type Pending = tokio::task::JoinHandle<Result<Value, ToolError>>;

fn pending_mutation(router: &Arc<ToolRouter>) -> Pending {
    let started = router.wait_started("c1");
    let reply = router.wait_for("c1");
    let router = router.clone();
    tokio::spawn(async move { wait_mutation(&router, "c1", started, reply).await })
}

async fn advance_ms(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
}

fn code_of(result: Result<Value, ToolError>) -> String {
    result.unwrap_err().code
}

#[tokio::test(start_paused = true)]
async fn a_mutation_that_never_starts_times_out_at_exactly_its_window() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1).await;
    tokio::task::yield_now().await;
    assert!(!wait.is_finished());
    advance_ms(1).await;
    let err = wait.await.unwrap().unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.contains("nothing changed"));
    assert!(!router.started("c1"));
}

#[tokio::test(start_paused = true)]
async fn a_started_mutation_that_goes_silent_is_outcome_unknown_at_exactly_its_window() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    assert!(router.started("c1"));
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1).await;
    tokio::task::yield_now().await;
    assert!(!wait.is_finished());
    advance_ms(1).await;
    let err = wait.await.unwrap().unwrap_err();
    assert_eq!(err.code, OUTCOME_UNKNOWN);
    assert!(err.message.contains("check the panel before you retry"));
}

#[tokio::test(start_paused = true)]
async fn a_started_racing_the_deadline_never_reports_timeout_after_being_accepted() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS).await;
    let accepted = router.started("c1");
    if accepted {
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "an accepted started must keep waiting for the reply"
        );
        assert!(router.answer("c1", &json!({ "ok": true, "value": { "staged": true } })));
        assert_eq!(wait.await.unwrap(), Ok(json!({ "staged": true })));
    } else {
        assert_eq!(code_of(wait.await.unwrap()), TIMEOUT);
    }
}

#[tokio::test(start_paused = true)]
async fn the_reply_window_restarts_when_the_action_starts() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1_000).await;
    assert!(router.started("c1"));
    tokio::task::yield_now().await;
    advance_ms(MUTATION_TIMEOUT_MS - 1_000).await;
    assert!(router.answer("c1", &json!({ "ok": true, "value": { "staged": true } })));
    assert_eq!(wait.await.unwrap(), Ok(json!({ "staged": true })));
}

#[tokio::test(start_paused = true)]
async fn a_reply_before_started_ends_the_call_with_the_reply() {
    let router = Arc::new(ToolRouter::default());
    let wait = pending_mutation(&router);
    tokio::task::yield_now().await;
    let reply = json!({ "ok": false, "error": { "code": "invalid_input", "message": "m" } });
    assert!(router.answer("c1", &reply));
    assert_eq!(code_of(wait.await.unwrap()), INVALID_INPUT);
    assert!(!router.started("c1"));
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_a_mutation_before_and_after_it_started() {
    let router = Arc::new(ToolRouter::default());
    let before = pending_mutation(&router);
    tokio::task::yield_now().await;
    router.drop_all();
    assert_eq!(code_of(before.await.unwrap()), CANCELLED);

    let after = pending_mutation(&router);
    tokio::task::yield_now().await;
    assert!(router.started("c1"));
    router.drop_all();
    assert_eq!(code_of(after.await.unwrap()), CANCELLED);
}

#[tokio::test(start_paused = true)]
async fn a_read_keeps_its_ten_second_window_and_has_no_started_signal() {
    let router = Arc::new(ToolRouter::default());
    let rx = router.wait_for("c1");
    assert!(!router.started("c1"));
    let wait = tokio::spawn(wait_renderer(rx));
    tokio::task::yield_now().await;
    advance_ms(RENDERER_TIMEOUT_MS + 1).await;
    assert_eq!(code_of(wait.await.unwrap()), TIMEOUT);
}

#[test]
fn started_is_refused_once_the_call_has_finished() {
    let router = ToolRouter::default();
    let _started = router.wait_started("c1");
    router.finish("c1");
    assert!(!router.started("c1"));
}

#[test]
fn started_resolves_only_inside_its_own_router() {
    let a = ToolRouter::default();
    let b = ToolRouter::default();
    let _started = a.wait_started("c1");
    assert!(!b.started("c1"));
    assert!(a.started("c1"));
    assert!(!a.started("c1"));
}

/// Real threads and a real clock: `started` lands anywhere from just before the window ends to
/// just after the deadline path has begun, which a paused single-thread clock cannot reach.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn started_racing_the_deadline_on_real_threads_never_loses_an_accepted_start() {
    const ROUNDS: usize = 60;
    const CALLS: usize = 48;
    let window = Duration::from_millis(2);
    let router = Arc::new(ToolRouter::default());
    let (mut accepted_total, mut refused_total) = (0, 0);
    for round in 0..ROUNDS {
        let base = std::time::Instant::now();
        let mut calls = Vec::with_capacity(CALLS);
        for i in 0..CALLS {
            let id = format!("r{round}-{i}");
            let started = router.wait_started(&id);
            let reply = router.wait_for(&id);
            let wait_router = router.clone();
            let wait_id = id.clone();
            let wait = tokio::spawn(async move {
                wait_mutation_within(window, &wait_router, &wait_id, started, reply).await
            });
            let start_router = router.clone();
            // Staggered across the timer tick so some starts land on each side of the deadline.
            let at = base + window + Duration::from_micros(25 * i as u64);
            let start = tokio::task::spawn_blocking(move || {
                while std::time::Instant::now() < at {
                    std::hint::spin_loop();
                }
                start_router.started(&id)
            });
            calls.push((wait, start));
        }
        for (wait, start) in calls {
            let accepted = start.await.unwrap();
            let code = code_of(wait.await.unwrap());
            if accepted {
                accepted_total += 1;
                assert_ne!(
                    code, TIMEOUT,
                    "an accepted start was reported as a safe timeout"
                );
            } else {
                refused_total += 1;
                assert_eq!(code, TIMEOUT);
            }
        }
    }
    eprintln!("race outcomes: accepted={accepted_total} refused={refused_total}");
}
