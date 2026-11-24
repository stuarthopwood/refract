// A blocking `extension_ui_request` Refract has no card for must be answered `cancelled`, or the agent
// waits forever; the fire-and-forget methods get neither a reply nor a notice.

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

#[tokio::test]
async fn a_form_request_is_answered_cancelled_and_leaves_a_notice_naming_it() {
    let fx = fixture(&[], &[]).await;

    fx.agent
        .handle_frame(json!({
            "type": "extension_ui_request",
            "id": "form-1",
            "method": "form",
            "html": "<form></form>",
            "timeout": 30000,
        }))
        .await;
    fx.until_rpc("extension_ui_response").await;

    assert_eq!(
        responses(&fx).await,
        vec![json!({ "type": "extension_ui_response", "id": "form-1", "cancelled": true })]
    );
    assert_eq!(
        fx.notices().await,
        vec!["Refract can't show the agent's `form` dialog yet, so it was cancelled.".to_string()]
    );
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
            "Refract can't show the agent's `some_future_dialog` dialog yet, so it was cancelled."
                .to_string()
        ]
    );
    fx.finish().await;
}

#[tokio::test]
async fn fire_and_forget_methods_and_an_unanswerable_frame_get_no_reply_and_no_notice() {
    let fx = fixture(&[], &[]).await;

    for method in [
        "setStatus",
        "setWidget",
        "setTitle",
        "set_editor_text",
        "open_url",
    ] {
        fx.agent.handle_frame(request("quiet", method)).await;
    }
    // No id means no one is waiting on a reply.
    fx.agent
        .handle_frame(json!({ "type": "extension_ui_request", "method": "form" }))
        .await;
    // The wire is ordered, so a reply to any frame above would show up before this sentinel's.
    fx.agent.handle_frame(request("sentinel", "form")).await;
    fx.until_rpc("extension_ui_response").await;

    let replied: Vec<Value> = responses(&fx)
        .await
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(replied, vec![json!("sentinel")]);
    assert_eq!(fx.notices().await.len(), 1);
    fx.finish().await;
}
