// File-size split (#564 follow-up, PLAN.md rule 11): `set_thinking_level` moved out of
// `session/model.rs` (which was back over the 600-line cap after #564's commit 1871f9b added it
// there) into its own file, declared next to `model.rs` in `session/mod.rs`. Pure move, no
// behaviour change: same body, same signature, same caller (`ipc::model::model_set_thinking_level`).
//
// #564: the composer's Reasoning picker. Forwards OMP's `set_thinking_level` RPC (`omp://rpc.md`'s
// own `ThinkingLevel` vocabulary, never re-validated here -- the same convention `model::set_model`'s
// provider/modelId arguments use, left to OMP's own RPC to reject an unknown value). Unlike
// `set_model`/`cycle_model`, this never pins the Session or touches its tracked role (#740/#454's
// pinning rule is a model/role concept; reasoning effort is orthogonal). Refuses while working
// (`request_rpc_if_idle`, the same rule `set_model` follows).

use serde_json::{json, Value};

use crate::omp::transcript::NoticeLevel;

use super::agent::{AgentError, SessionAgent};
use super::model::model_support::post_notice;

/// Mirrors `session::model`'s own `REQUEST_TIMEOUT_MS` (private there, re-declared here with the
/// same value and the same convention `model.rs` itself documents for a value it does not export).
const REQUEST_TIMEOUT_MS: u64 = 60_000;

pub async fn set_thinking_level(agent: &SessionAgent, level: &str) -> Result<Value, AgentError> {
    let res = agent
        .request_rpc_if_idle(
            json!({ "type": "set_thinking_level", "level": level }),
            REQUEST_TIMEOUT_MS,
            "Switch the thinking level",
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Thinking level not set.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Thinking level switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let thinking_level = data
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AgentError::new(
                "prompt-failed",
                "Thinking level switched, but the new level could not be read.",
            )
        })?
        .to_string();
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Thinking level switched to {thinking_level}."),
    )
    .await;
    Ok(json!({ "thinkingLevel": thinking_level }))
}
