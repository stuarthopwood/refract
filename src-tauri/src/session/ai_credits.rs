//! Issue #1238 (spec 004 FR-050): the Session's AI credits for the Context usage readout.

use serde_json::{json, Value};

use super::agent::SessionAgent;

const AI_CREDITS_TIMEOUT_MS: u64 = 5_000;

/// OMP's session cost in dollars times 100 (1 credit = $0.01), only for a GitHub Copilot model;
/// `None` for any other provider or when the stats call fails.
pub(super) async fn fetch_ai_credits(agent: &SessionAgent, state: &Value) -> Option<f64> {
    let provider = state.get("model")?.get("provider")?.as_str()?;
    if provider != "github-copilot" {
        return None;
    }
    let stats = agent
        .request_rpc(json!({ "type": "get_session_stats" }), AI_CREDITS_TIMEOUT_MS)
        .await
        .ok()?;
    if stats.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let cost = stats.get("data")?.get("cost")?.as_f64()?;
    (cost.is_finite() && cost >= 0.0).then_some(cost * 100.0)
}
