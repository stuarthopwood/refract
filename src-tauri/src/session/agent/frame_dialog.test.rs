// A blocking `extension_ui_request` Refract has no card for must be answered `cancelled`, or the agent
// waits forever; the fire-and-forget methods get neither a reply nor a notice. A `form` with `html`
// becomes a card (#2140) and goes out as `data` or `cancelled`.

use serde_json::{json, Value};

use crate::session::agent::pause_subagents::fixture::{fixture, Fixture};

fn request(id: &str, method: &str) -> Value {
    json!({ "type": "extension_ui_request", "id": id, "method": method })
}

/// Every `extension_ui_response` the stub OMP received, in wire order.
async fn responses(fx: &Fixture) -> Vec<Value> {
    fx.rpcs()
        .await
        .into_iter()
        .filter(|cmd| cmd["type"] == "extension_ui_response")
        .collect()
}

fn form_frame(id: &str) -> Value {
    json!({
        "type": "extension_ui_request",
        "id": id,
        "method": "form",
        "html": "<form><input name=\"title\"></form>",
        "timeout": 30000,
    })
}

#[tokio::test]
async fn a_form_request_becomes_a_pending_card_and_its_data_goes_out_verbatim() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(form_frame("form-1")).await;

    let pending = fx.agent.pending_requests().await;
    assert_eq!(pending.len(), 1);
    let card = serde_json::to_value(&pending[0]).unwrap();
    assert_eq!(card["kind"], "form");
    assert_eq!(card["requestId"], "form-1");
    assert_eq!(card["html"], "<form><input name=\"title\"></form>");
    assert!(card["deadlineAt"].is_i64());
    assert!(
        responses(&fx).await.is_empty(),
        "the card is not auto-answered"
    );
    assert!(fx.notices().await.is_empty());

    let data = json!({ "title": "Ship it", "count": 3, "tags": ["a", "b"] });
    fx.agent
        .answer_request("form-1".into(), json!({ "data": data }))
        .await
        .unwrap();
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "form-1", "data": data })]
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn cancelling_a_form_card_replies_cancelled() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(form_frame("form-2")).await;
    fx.agent
        .answer_request("form-2".into(), json!({ "cancelled": true }))
        .await
        .unwrap();
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "form-2", "cancelled": true })]
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_form_answer_of_the_wrong_shape_is_refused_and_the_card_stays() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(form_frame("form-3")).await;
    for bad in [json!({ "value": "x" }), json!({ "data": { "a": true } })] {
        let err = fx
            .agent
            .answer_request("form-3".into(), bad)
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid-argument");
    }

    assert_eq!(fx.agent.pending_requests().await.len(), 1);
    assert!(responses(&fx).await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn an_over_cap_form_answer_is_refused_as_invalid_and_the_card_stays() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(form_frame("form-5")).await;
    let too_long = json!({ "data": { "title": "a".repeat(64 * 1024 + 1) } });
    let err = fx
        .agent
        .answer_request("form-5".into(), too_long)
        .await
        .unwrap_err();

    assert_eq!(err.code, "invalid-argument");
    assert_eq!(fx.agent.pending_requests().await.len(), 1);
    assert!(responses(&fx).await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn a_form_answer_with_cancelled_false_resolves_answered_not_cancelled() {
    use crate::omp::transcript::{RequestResolution, TranscriptItem};

    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(form_frame("form-6")).await;
    fx.agent
        .answer_request(
            "form-6".into(),
            json!({ "data": { "title": "Ship it" }, "cancelled": false }),
        )
        .await
        .unwrap();
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({
            "type": "extension_ui_response",
            "id": "form-6",
            "data": { "title": "Ship it" }
        })]
    );
    let state = fx.agent.state.lock().await;
    let resolved = state
        .transcript
        .items()
        .iter()
        .find_map(|item| match &**item {
            TranscriptItem::Request {
                request_id,
                resolved,
                ..
            } if request_id == "form-6" => Some(*resolved),
            _ => None,
        });
    assert_eq!(resolved, Some(Some(RequestResolution::Answered)));
    drop(state);
    fx.finish().await;
}

#[tokio::test]
async fn a_process_exit_drops_a_pending_form_request() {
    let fx = fixture(&[], &[]).await;
    fx.agent.handle_frame(form_frame("form-7")).await;
    assert_eq!(fx.agent.pending_requests().await.len(), 1);
    let proc = fx.agent.state.lock().await.process.clone().unwrap();

    fx.agent.handle_exit(&proc, Some(1), false).await;

    assert!(fx.agent.pending_requests().await.is_empty());
    proc.stop().await;
}

#[tokio::test]
async fn a_form_request_without_html_is_answered_cancelled_and_leaves_a_notice_naming_it() {
    let fx = fixture(&[], &[]).await;

    fx.agent.handle_frame(request("form-4", "form")).await;
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "form-4", "cancelled": true })]
    );
    assert_eq!(
        fx.notices().await,
        vec![
            r#"Refract can't show the agent's "form" dialog yet, so it was cancelled."#.to_string()
        ]
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    fx.finish().await;
}

#[tokio::test]
async fn an_unknown_blocking_method_gets_the_same_cancelled_reply_and_notice() {
    let fx = fixture(&[], &[]).await;

    fx.agent
        .handle_frame(request("future-1", "some_future_dialog"))
        .await;
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "future-1", "cancelled": true })]
    );
    assert_eq!(
        fx.notices().await,
        vec![
            r#"Refract can't show the agent's "some_future_dialog" dialog yet, so it was cancelled."#
                .to_string()
        ]
    );
    fx.finish().await;
}

#[tokio::test]
async fn fire_and_forget_methods_and_an_unanswerable_frame_get_no_reply_and_no_notice() {
    let fx = fixture(&[], &[]).await;
    let mut sentinels: Vec<Value> = Vec::new();

    // The id-less `form` case has its own sentinel method: with the shared one, a stray `form`
    // notice would read the same as the sentinel's and collapse into it.
    let quiet: [(&str, &str, Value); 6] = [
        (
            "setStatus",
            "sentinel_dialog",
            request("quiet", "setStatus"),
        ),
        (
            "setWidget",
            "sentinel_dialog",
            request("quiet", "setWidget"),
        ),
        ("setTitle", "sentinel_dialog", request("quiet", "setTitle")),
        (
            "set_editor_text",
            "sentinel_dialog",
            request("quiet", "set_editor_text"),
        ),
        ("open_url", "sentinel_dialog", request("quiet", "open_url")),
        // No id means no one is waiting on a reply.
        (
            "form without an id",
            "idless_form_sentinel_dialog",
            json!({ "type": "extension_ui_request", "method": "form" }),
        ),
    ];
    let mut expected_notices = 0;
    for (name, sentinel_method, frame) in quiet {
        fx.agent.handle_frame(frame).await;
        // The wire is ordered, so a reply to the frame above would show up before this sentinel's.
        let sentinel = format!("sentinel-{name}");
        fx.agent
            .handle_frame(request(&sentinel, sentinel_method))
            .await;
        sentinels.push(json!(sentinel));
        fx.until_rpc_count("extension_ui_response", sentinels.len())
            .await;

        let replied: Vec<Value> = responses(&fx)
            .await
            .iter()
            .map(|r| r["id"].clone())
            .collect();
        assert_eq!(replied, sentinels, "{name} was answered");
        // Each distinct sentinel method adds one notice (equal text collapses); nothing else may.
        if sentinels.len() == 1 || sentinel_method != "sentinel_dialog" {
            expected_notices += 1;
        }
        assert_eq!(
            fx.notices().await.len(),
            expected_notices,
            "{name} left a notice"
        );
    }
    fx.finish().await;
}

#[tokio::test]
async fn away_mode_cancels_a_form_card_instead_of_leaving_the_agent_waiting() {
    let fx = fixture(&[], &[]).await;
    crate::session::working_mode::away::enter_for_test(&fx.agent).await;

    fx.agent.handle_frame(form_frame("form-5")).await;
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "form-5", "cancelled": true })]
    );
    assert!(fx.agent.pending_requests().await.is_empty());
    assert_eq!(
        fx.notices().await,
        vec![
            "Automatic (Away mode): question \"the agent's form\" cancelled because the user is away."
                .to_string()
        ]
    );
    fx.finish().await;
}
