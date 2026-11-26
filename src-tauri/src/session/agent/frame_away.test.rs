// Away Mode answers every dialog and denies approvals; it never cancels, because a cancelled
// dialog stops the agent's turn (#2031, ADR 0014, FR-151). Each answer also steers the agent.

use serde_json::{json, Value};

use crate::session::agent::pause_subagents::fixture::{fixture, fixture_with, Fixture, Stub};
use crate::session::agent::SessionStatus;
use crate::session::working_mode::away::{
    enter_for_test, leave_for_test, on_request, send_steer, summarise, sweep, Kind, ANSWERED_STEER,
    ASK_FALLBACK, CANCELLED_STEER, DENIED_STEER,
};
use crate::session::working_mode::decorate_prompt;

async fn away_fixture() -> Fixture {
    let fx = fixture(&[], &[]).await;
    enter_for_test(&fx.agent).await;
    // The steer goes out only while a turn is running.
    fx.agent.state.lock().await.status = crate::session::agent::SessionStatus::Working;
    fx
}

fn dialog(id: &str, method: &str, extra: Value) -> Value {
    let mut frame = json!({ "type": "extension_ui_request", "id": id, "method": method });
    frame
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    frame
}

/// Sends the frame and returns the single `extension_ui_response` the agent got back.
async fn answer_of(fx: &Fixture, frame: Value) -> Value {
    fx.agent.handle_frame(frame).await;
    fx.until_rpc("extension_ui_response").await;
    let mut replies: Vec<Value> = fx
        .rpcs()
        .await
        .into_iter()
        .filter(|cmd| cmd["type"] == "extension_ui_response")
        .collect();
    assert_eq!(replies.len(), 1, "one reply per dialog");
    replies.remove(0)
}

/// The steer prompts the agent received, after waiting for the first.
async fn steers(fx: &Fixture) -> Vec<Value> {
    fx.until_rpc("prompt").await;
    fx.rpcs()
        .await
        .into_iter()
        .filter(|cmd| cmd["type"] == "prompt")
        .collect()
}

fn steer(message: &str) -> Value {
    json!({ "streamingBehavior": "steer", "message": message })
}

fn assert_steered(prompts: &[Value], message: &str) {
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["type"], "prompt");
    assert_eq!(
        prompts[0]["streamingBehavior"],
        steer(message)["streamingBehavior"]
    );
    assert_eq!(prompts[0]["message"], steer(message)["message"]);
}

#[tokio::test]
async fn away_answers_an_ask_with_the_recommended_option_and_steers() {
    let fx = away_fixture().await;
    let frame = dialog(
        "ask-1",
        "ask",
        json!({ "questions": [{
            "id": "q1",
            "question": "Which one?",
            "options": [{ "label": "A" }, { "label": "B" }],
            "recommended": 1,
        }] }),
    );

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply["answers"],
        json!([{ "id": "q1", "selectedOptions": ["B"] }])
    );
    assert_eq!(reply.get("cancelled"), None);
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    assert_eq!(
        fx.notices().await,
        vec!["Automatic (Away mode): answered \"Which one?\" with B.".to_string()]
    );
    fx.finish().await;
}

#[tokio::test]
async fn away_answers_a_select_with_its_first_option_and_steers() {
    let fx = away_fixture().await;
    let frame = dialog(
        "sel-1",
        "select",
        json!({ "title": "Pick a colour", "options": ["Red", "Blue"] }),
    );

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "sel-1", "value": "Red" })
    );
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    assert_eq!(
        fx.notices().await,
        vec!["Automatic (Away mode): answered \"Pick a colour\" with Red.".to_string()]
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn away_answers_a_confirm_no_and_steers() {
    let fx = away_fixture().await;
    let frame = dialog(
        "conf-1",
        "confirm",
        json!({ "title": "Delete the branch?" }),
    );

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "conf-1", "confirmed": false })
    );
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    assert_eq!(
        fx.notices().await,
        vec!["Automatic (Away mode): answered \"Delete the branch?\" with No.".to_string()]
    );
    fx.finish().await;
}

#[tokio::test]
async fn away_answers_a_text_dialog_with_the_away_reply_and_steers() {
    let fx = away_fixture().await;
    let frame = dialog("in-1", "input", json!({ "title": "Branch name?" }));

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "in-1", "value": ASK_FALLBACK })
    );
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    fx.finish().await;
}

#[tokio::test]
async fn away_submits_a_form_with_default_values_and_steers() {
    let fx = away_fixture().await;
    let html = "<form><select name=\"size\"><option>S</option><option>M</option></select>\
                <input type=\"radio\" name=\"mode\" value=\"fast\">\
                <input type=\"radio\" name=\"mode\" value=\"slow\">\
                <input name=\"note\"></form>";
    let frame = dialog("form-5", "form", json!({ "html": html }));

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply,
        json!({
            "type": "extension_ui_response",
            "id": "form-5",
            "data": { "size": "S", "mode": "fast", "note": ASK_FALLBACK },
        })
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    assert_eq!(
        fx.notices().await,
        vec![
            "Automatic (Away mode): answered \"the agent's form\" with default values.".to_string()
        ]
    );
    fx.finish().await;
}

#[tokio::test]
async fn away_denies_an_approval_at_once_and_steers() {
    let fx = away_fixture().await;
    let frame = dialog(
        "appr-1",
        "select",
        json!({
            "title": "Allow tool: bash\nCommand: rm -rf build",
            "options": ["Allow", "Deny"],
        }),
    );

    let reply = answer_of(&fx, frame).await;

    assert_eq!(
        reply,
        json!({ "type": "extension_ui_response", "id": "appr-1", "value": "Deny" })
    );
    assert_steered(&steers(&fx).await, DENIED_STEER);
    assert_eq!(
        fx.notices().await,
        vec![
            "Automatic (Away mode): denied approval for \"bash rm -rf build\". Not approved: the user is away. Pick a safe alternative or skip this step and continue."
                .to_string()
        ]
    );
    fx.finish().await;
}

#[tokio::test]
async fn decorate_prompt_adds_the_away_instruction_only_in_away() {
    let fx = away_fixture().await;

    let away = decorate_prompt(&fx.agent, "Do the work".to_string()).await;
    let slash = decorate_prompt(&fx.agent, "/compact".to_string()).await;
    leave_for_test(&fx.agent).await;
    let interactive = decorate_prompt(&fx.agent, "Do the work".to_string()).await;

    assert!(away.starts_with("Do the work"));
    assert!(away.contains("Away mode is on"));
    assert!(away.contains("Do not use the ask tool"));
    assert_eq!(slash, "/compact");
    assert_eq!(interactive, "Do the work");
    fx.finish().await;
}

fn prompt_count(cmds: &[Value]) -> usize {
    cmds.iter().filter(|cmd| cmd["type"] == "prompt").count()
}

#[tokio::test]
async fn away_answers_a_yes_no_select_with_no() {
    let fx = away_fixture().await;
    let frame = dialog(
        "sel-2",
        "select",
        json!({ "title": "Proceed?", "options": ["Yes", "No"] }),
    );

    let reply = answer_of(&fx, frame).await;

    assert_eq!(reply["value"], "No");
    fx.finish().await;
}

#[tokio::test]
async fn away_answers_an_environment_select_with_staging_and_a_plan_select_with_refine() {
    let fx = away_fixture().await;
    let env = dialog(
        "sel-3",
        "select",
        json!({ "title": "Deploy to?", "options": ["Staging", "Production"] }),
    );
    assert_eq!(answer_of(&fx, env).await["value"], "Staging");
    fx.finish().await;

    let fx = away_fixture().await;
    let plan = dialog(
        "sel-4",
        "select",
        json!({ "title": "Plan ready", "options": ["Approve and execute", "Refine plan"] }),
    );
    assert_eq!(answer_of(&fx, plan).await["value"], "Refine plan");
    fx.finish().await;
}

async fn assert_cancelled_and_steered(fx: &Fixture, frame: Value, notice: &str) {
    let reply = answer_of(fx, frame).await;
    assert_eq!(reply["cancelled"], true);
    assert_steered(&steers(fx).await, CANCELLED_STEER);
    let notices = fx.notices().await;
    assert_eq!(
        notices.len(),
        1,
        "one notice, not the interactive error too"
    );
    assert!(notices[0].contains(notice), "{}", notices[0]);
}

#[tokio::test]
async fn away_cancels_a_select_with_no_options_and_says_why() {
    let fx = away_fixture().await;
    let frame = dialog(
        "sel-5",
        "select",
        json!({ "title": "Pick one", "options": [] }),
    );
    assert_cancelled_and_steered(&fx, frame, "cancelled \"Pick one\"").await;
    fx.finish().await;
}

#[tokio::test]
async fn away_cancels_a_malformed_ask_and_says_why() {
    let fx = away_fixture().await;
    let frame = dialog("ask-2", "ask", json!({ "questions": [] }));
    assert_cancelled_and_steered(&fx, frame, "cancelled \"the agent's question\"").await;
    fx.finish().await;
}

#[tokio::test]
async fn away_cancels_an_unsupported_method_and_a_form_without_html() {
    let fx = away_fixture().await;
    let frame = dialog("x-1", "custom_widget", json!({}));
    assert_cancelled_and_steered(&fx, frame, "custom_widget").await;
    fx.finish().await;

    let fx = away_fixture().await;
    let frame = dialog("form-6", "form", json!({}));
    assert_cancelled_and_steered(&fx, frame, "\"form\" dialog").await;
    fx.finish().await;
}

#[tokio::test]
async fn away_sends_no_steer_while_the_session_is_idle() {
    let fx = away_fixture().await;
    fx.agent.state.lock().await.status = SessionStatus::Idle;

    send_steer(&fx.agent, Kind::Answered).await;

    assert_eq!(prompt_count(&fx.rpcs().await), 0);
    fx.finish().await;
}

#[tokio::test]
async fn a_burst_of_replies_sends_one_steer_while_it_is_in_flight() {
    let fx = fixture_with(Stub {
        gated: Some("prompt"),
        ..Stub::default()
    })
    .await;
    enter_for_test(&fx.agent).await;
    fx.agent.state.lock().await.status = SessionStatus::Working;
    for id in ["b-1", "b-2", "b-3"] {
        let frame = dialog(id, "select", json!({ "title": id, "options": ["Red"] }));
        fx.agent.handle_frame(frame).await;
    }
    fx.until_notices(3).await;
    fx.until_rpc("prompt").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    assert_eq!(prompt_count(&fx.rpcs().await), 1);
    fx.release().await;
    fx.finish().await;
}

/// Plants a pending select while Interactive, so nothing answers it before Away starts.
async fn pending_select(fx: &Fixture, id: &str) {
    enter_for_test(&fx.agent).await;
    leave_for_test(&fx.agent).await;
    let frame = dialog(
        id,
        "select",
        json!({ "title": "Pick", "options": ["Red", "Blue"] }),
    );
    fx.agent.handle_frame(frame).await;
    assert_eq!(fx.agent.pending_requests().await.len(), 1);
}

#[tokio::test]
async fn entering_away_answers_a_request_already_pending() {
    let fx = fixture(&[], &[]).await;
    fx.agent.state.lock().await.status = SessionStatus::Working;
    pending_select(&fx, "early-1").await;

    enter_for_test(&fx.agent).await;
    sweep(&fx.agent).await;

    fx.until_rpc("extension_ui_response").await;
    assert!(fx.agent.pending_requests().await.is_empty());
    assert_steered(&steers(&fx).await, ANSWERED_STEER);
    fx.finish().await;
}

#[tokio::test]
async fn a_request_raced_by_on_request_and_sweep_is_answered_once() {
    let fx = fixture(&[], &[]).await;
    fx.agent.state.lock().await.status = SessionStatus::Working;
    pending_select(&fx, "race-1").await;
    let request = fx.agent.pending_requests().await.remove(0);
    enter_for_test(&fx.agent).await;

    tokio::join!(on_request(&fx.agent, request), sweep(&fx.agent));

    fx.until_rpc("extension_ui_response").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let cmds = fx.rpcs().await;
    let replies = cmds
        .iter()
        .filter(|c| c["type"] == "extension_ui_response")
        .count();
    assert_eq!(replies, 1, "one reply");
    assert_eq!(fx.notices().await.len(), 1, "one log entry");
    assert_eq!(prompt_count(&cmds), 1, "one steer");
    fx.finish().await;
}

#[tokio::test]
async fn leaving_away_posts_the_answered_and_denied_lines() {
    let fx = away_fixture().await;
    let select = dialog(
        "s-1",
        "select",
        json!({ "title": "Pick", "options": ["Red"] }),
    );
    fx.agent.handle_frame(select).await;
    let approval = dialog(
        "s-2",
        "select",
        json!({ "title": "Allow tool: bash\nCommand: ls", "options": ["Allow", "Deny"] }),
    );
    fx.agent.handle_frame(approval).await;
    fx.until_notices(2).await;

    summarise(&fx.agent).await;

    let notices = fx.notices().await;
    let card = notices.last().unwrap();
    assert!(
        card.starts_with("While you were away, 2 automatic action(s):"),
        "{card}"
    );
    assert!(card.contains("- Answered \"Pick\" with Red."), "{card}");
    assert!(
        card.contains("- Denied approval for \"bash ls\"."),
        "{card}"
    );
    fx.finish().await;
}
