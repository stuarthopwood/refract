// Pause cancels the Session's running subagents, and any subagent that starts while it is paused.

use serde_json::{json, Value};
use tokio::task::JoinSet;

use super::SessionAgent;

/// Short so Pause stays responsive when OMP is slow; Pause waits for these RPCs, never for subagents.
const SUBAGENT_RPC_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, PartialEq)]
enum Outcome {
    Cancelled,
    /// Already settled, or the cancel raced its finish.
    NothingToCancel,
    Failed(String),
}

fn rpc_error(response: &Value) -> String {
    response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown error")
        .to_string()
}

fn classify(response: &Value) -> Outcome {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        let cancelled = response.pointer("/data/cancelled").and_then(Value::as_bool);
        return if cancelled == Some(true) {
            Outcome::Cancelled
        } else {
            Outcome::NothingToCancel
        };
    }
    let error = rpc_error(response);
    if error.contains("not running") {
        Outcome::NothingToCancel
    } else {
        Outcome::Failed(error)
    }
}

fn listed_ids(response: &Value) -> Result<Vec<String>, String> {
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(rpc_error(response));
    }
    let listed = response
        .pointer("/data/subagents")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    Ok(listed
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect())
}

fn describe(ids: &[String]) -> String {
    let noun = if ids.len() == 1 {
        "subagent"
    } else {
        "subagents"
    };
    format!("{} {noun}: {}", ids.len(), ids.join(", "))
}

impl SessionAgent {
    async fn cancel_subagent(&self, id: &str) -> Outcome {
        let command = json!({ "type": "cancel_subagent", "subagentId": id });
        match self.request_rpc(command, SUBAGENT_RPC_TIMEOUT_MS).await {
            Ok(response) => classify(&response),
            Err(err) => Outcome::Failed(err.message),
        }
    }

    async fn running_subagent_ids(&self) -> Result<Vec<String>, String> {
        let command = json!({ "type": "get_subagents" });
        match self.request_rpc(command, SUBAGENT_RPC_TIMEOUT_MS).await {
            Ok(response) => listed_ids(&response),
            Err(err) => Err(err.message),
        }
    }

    async fn is_gating(&self) -> bool {
        self.state.lock().await.pause.is_gating()
    }

    /// Records cancelled ids and posts notices in one lock hold, and only while the Session still
    /// gates: after Resume they are stale and would read after its "Resumed" notice. Returns
    /// whether it applied.
    async fn record_and_note(&self, cancelled: &[String], notices: &[(String, &str)]) -> bool {
        let mut state = self.state.lock().await;
        if !state.pause.is_gating() {
            return false;
        }
        for id in cancelled {
            if !state.pause.cancelled.contains(id) {
                state.pause.cancelled.push(id.clone());
            }
        }
        for (text, level) in notices {
            let frame = json!({ "type": "notice", "level": level, "message": text });
            self.apply_frame_locked(&mut state, &frame);
        }
        true
    }

    /// Cancels every running subagent. A listing or cancel failure never stops the pause; it only
    /// shows as a notice. The cancels go out concurrently so N subagents cost one RPC timeout.
    pub(super) async fn cancel_running_subagents(&self) {
        if self.state.lock().await.process.is_none() {
            return;
        }
        let ids = match self.running_subagent_ids().await {
            Ok(ids) => ids,
            Err(reason) => {
                log::warn!("pause: could not list subagents: {reason}");
                let notice = format!("Pause could not list the running subagents: {reason}");
                self.record_and_note(&[], &[(notice, "error")]).await;
                return;
            }
        };
        // A Resume that landed during the listing wins: nothing is cancelled.
        if !self.is_gating().await {
            return;
        }
        let mut requests = JoinSet::new();
        for id in ids {
            let agent = self.arc();
            requests.spawn(async move {
                let outcome = agent.cancel_subagent(&id).await;
                (id, outcome)
            });
        }
        let (mut cancelled, mut failed) = (Vec::new(), Vec::new());
        while let Some(joined) = requests.join_next().await {
            let Ok((id, outcome)) = joined else { continue };
            match outcome {
                Outcome::Cancelled => cancelled.push(id),
                Outcome::NothingToCancel => {}
                Outcome::Failed(reason) => {
                    log::warn!("pause: could not cancel subagent {id}: {reason}");
                    failed.push(format!("{id} ({reason})"));
                }
            }
        }
        cancelled.sort();
        failed.sort();
        let mut notices = Vec::new();
        if !cancelled.is_empty() {
            notices.push((format!("Pause cancelled {}.", describe(&cancelled)), "info"));
        }
        if !failed.is_empty() {
            notices.push((
                format!("Pause could not cancel {}.", describe(&failed)),
                "error",
            ));
        }
        self.record_and_note(&cancelled, &notices).await;
    }

    /// OMP has no pause gate, so a subagent that starts mid-pause is cancelled from its
    /// lifecycle frame. Spawned so the frame handler never waits on the RPC.
    pub(super) async fn on_subagent_started(&self, payload: &Value) {
        if payload.get("status").and_then(Value::as_str) != Some("started") {
            return;
        }
        let Some(id) = payload.get("id").and_then(Value::as_str) else {
            return;
        };
        self.ensure_pause_loaded().await;
        if !self.is_gating().await {
            return;
        }
        let agent = self.arc();
        let id = id.to_string();
        tokio::spawn(async move { agent.auto_cancel(&id).await });
    }

    async fn auto_cancel(&self, id: &str) {
        // Resume may have landed between the frame and this task starting.
        if !self.is_gating().await {
            return;
        }
        match self.cancel_subagent(id).await {
            Outcome::Cancelled => {
                let notice = format!(
                    "Pause cancelled subagent {id}, which started while this Session was paused."
                );
                let applied = self
                    .record_and_note(&[id.to_string()], &[(notice, "info")])
                    .await;
                if !applied {
                    // Resume landed mid-cancel: the subagent is gone and Resume's notice
                    // cannot name it, so say so rather than lose it silently.
                    self.append_notice(
                        format!(
                            "Pause cancelled subagent {id}, which started as this Session was resumed. It is not restarted."
                        ),
                        "info",
                    )
                    .await;
                }
            }
            Outcome::NothingToCancel => {}
            Outcome::Failed(reason) => {
                log::warn!("pause: could not cancel new subagent {id}: {reason}");
                let notice = format!(
                    "Pause could not cancel subagent {id}, which started while this Session was paused: {reason}"
                );
                self.record_and_note(&[], &[(notice, "error")]).await;
            }
        }
    }

    /// Resume does not restart what Pause cancelled; the notice tells the user which ones to re-run.
    pub(super) async fn notify_resumed(&self, cancelled: Vec<String>) {
        if cancelled.is_empty() {
            return;
        }
        self.append_notice(
            format!(
                "Resumed. Pause had cancelled {}. They are not restarted; ask the agent to run them again if you still need them.",
                describe(&cancelled)
            ),
            "info",
        )
        .await;
    }
}

#[cfg(test)]
#[path = "pause_subagents_fixture.test.rs"]
mod fixture;
#[cfg(test)]
#[path = "pause_subagents_races.test.rs"]
mod races;
#[cfg(test)]
#[path = "pause_subagents.test.rs"]
mod tests;
