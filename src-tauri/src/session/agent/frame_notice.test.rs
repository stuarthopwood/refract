// The source on a transcript notice (#2114): an extension's `notify` carries it, Refract's own notices do not.

use serde_json::json;

use crate::omp::transcript::{NoticeSource, TranscriptItem};
use crate::session::agent::pause_subagents::fixture::fixture;

fn notice_sources(items: &[std::sync::Arc<TranscriptItem>]) -> Vec<(String, Option<NoticeSource>)> {
    items
        .iter()
        .filter_map(|item| match &**item {
            TranscriptItem::Notice { text, source, .. } => Some((text.clone(), *source)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_extension_notify_notice_carries_the_source_and_a_lane_notice_does_not() {
    let fx = fixture(&[], &[]).await;

    fx.agent
        .handle_frame(json!({
            "type": "extension_ui_request",
            "id": "n1",
            "method": "notify",
            "message": "hello from an extension",
            "notifyType": "info",
        }))
        .await;
    fx.agent
        .lane_notice("Away mode approved a tool.".to_string(), "info")
        .await;

    let state = fx.agent.state.lock().await;
    let sources = notice_sources(state.transcript.items());
    assert_eq!(
        sources,
        vec![
            (
                "hello from an extension".to_string(),
                Some(NoticeSource::Extension)
            ),
            ("Away mode approved a tool.".to_string(), None),
        ]
    );
    // The source survives the wire: the renderer reads it from the serialized item.
    let wire = serde_json::to_value(&*state.transcript.items()[0]).unwrap();
    assert_eq!(wire["source"], "extension");
    let lane_wire = serde_json::to_value(&*state.transcript.items()[1]).unwrap();
    assert!(lane_wire.get("source").is_none());
    drop(state);
    fx.finish().await;
}
