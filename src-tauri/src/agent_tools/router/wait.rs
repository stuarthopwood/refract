// How a host tool call waits for the renderer. Split from `router.rs` to keep it under the file cap.

use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;

use super::{Reply, ToolError, ToolRouter, CANCELLED, OUTCOME_UNKNOWN, TIMEOUT};
use crate::agent_tools::{MUTATION_TIMEOUT_MS, RENDERER_TIMEOUT_MS};

fn renderer_result(reply: Result<Reply, oneshot::error::RecvError>) -> Result<Value, ToolError> {
    match reply {
        Ok(Reply::Renderer(result)) => result,
        _ => Err(ToolError::new(CANCELLED, "the call was cancelled")),
    }
}

/// A read or navigation action: one window from emit to the renderer's reply.
pub(super) async fn wait_renderer(rx: oneshot::Receiver<Reply>) -> Result<Value, ToolError> {
    match tokio::time::timeout(Duration::from_millis(RENDERER_TIMEOUT_MS), rx).await {
        Ok(reply) => renderer_result(reply),
        Err(_) => Err(ToolError::new(
            TIMEOUT,
            format!(
                "the panel did not answer within {} seconds",
                RENDERER_TIMEOUT_MS / 1000
            ),
        )),
    }
}

enum Early {
    Reply(Result<Reply, oneshot::error::RecvError>),
    Started(Result<(), oneshot::error::RecvError>),
    Silent,
}

/// A file-changing action. Before `started` a silence is `timeout` (nothing changed, a retry is
/// safe); after it, a silence is `outcome_unknown`, because the files may already have changed.
pub(super) async fn wait_mutation(
    router: &ToolRouter,
    call_id: &str,
    started: oneshot::Receiver<()>,
    reply: oneshot::Receiver<Reply>,
) -> Result<Value, ToolError> {
    let window = Duration::from_millis(MUTATION_TIMEOUT_MS);
    wait_mutation_within(window, router, call_id, started, reply).await
}

/// Split out so the race test can use a window of a few milliseconds on a real clock.
pub(super) async fn wait_mutation_within(
    window: Duration,
    router: &ToolRouter,
    call_id: &str,
    mut started: oneshot::Receiver<()>,
    mut reply: oneshot::Receiver<Reply>,
) -> Result<Value, ToolError> {
    let early = tokio::select! {
        biased;
        r = &mut reply => Early::Reply(r),
        s = &mut started => Early::Started(s),
        _ = tokio::time::sleep(window) => Early::Silent,
    };
    match early {
        Early::Reply(reply) => return renderer_result(reply),
        Early::Started(Ok(())) => {}
        Early::Started(Err(_)) => return Err(ToolError::new(CANCELLED, "the call was cancelled")),
        Early::Silent => {
            // `started` sends while holding the router's lock, so once `forget_start` returns
            // either its value is already in the channel or it will be refused.
            router.forget_start(call_id);
            if started.try_recv().is_err() {
                return Err(ToolError::new(
                    TIMEOUT,
                    format!(
                        "the panel did not start the action within {} seconds; nothing changed, so a retry is safe",
                        MUTATION_TIMEOUT_MS / 1000
                    ),
                ));
            }
        }
    }
    match tokio::time::timeout(window, reply).await {
        Ok(reply) => renderer_result(reply),
        Err(_) => Err(ToolError::new(
            OUTCOME_UNKNOWN,
            "the action started and its outcome is unknown, so check the panel before you retry",
        )),
    }
}

#[cfg(test)]
#[path = "wait.test.rs"]
mod tests;
