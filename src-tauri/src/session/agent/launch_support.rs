// Launch helpers shared by `launch.rs`, `conversations.rs` and `requests.rs`, split out to stay under the 600-line cap.

use serde_json::{json, Value};

use crate::omp::process::{ApprovalMode as ProcApprovalMode, OmpProcess};
use crate::store::registry::Session;
use crate::store::settings::ApprovalMode;

use super::{SessionAgent, DEFAULT_REQUEST_TIMEOUT_MS, MAX_MESSAGE_PAGES, MESSAGES_PAGE_SIZE};

/// `RegistryStoreError` has no `Display` impl, so its message is mapped by hand here.
pub(super) fn registry_store_error_message(
    err: crate::store::registry::RegistryStoreError,
) -> String {
    match err {
        crate::store::registry::RegistryStoreError::Registry(e) => e.message,
        crate::store::registry::RegistryStoreError::Io(e) => e.to_string(),
    }
}

pub(super) fn to_process_mode(mode: ApprovalMode) -> ProcApprovalMode {
    match mode {
        ApprovalMode::Ask => ProcApprovalMode::Ask,
        ApprovalMode::AskAndRemember => ProcApprovalMode::AskAndRemember,
        ApprovalMode::EditFreely => ProcApprovalMode::EditFreely,
        ApprovalMode::Auto => ProcApprovalMode::Auto,
    }
}

/// Also bounds approval-dialog target strings in `agent::requests`.
pub(super) fn truncate(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
}

/// Checked before `switch_session`, so a missing conversation file fails with a testable message.
pub(super) async fn assert_conversation_file_exists(file: &str) -> Result<(), String> {
    if tokio::fs::metadata(file).await.is_err() {
        return Err(format!("Conversation file missing: {file}"));
    }
    Ok(())
}
/// Windows paths compare case-insensitively; both sides are already absolute, so no canonicalisation.
pub(super) fn verify_reattach(expected_file: &str, state: &Value) -> Result<(), String> {
    let session_file = state
        .get("sessionFile")
        .and_then(Value::as_str)
        .unwrap_or("");
    if session_file.to_lowercase() != expected_file.to_lowercase() {
        return Err(format!("Reattach verification failed: sessionFile mismatch (expected {expected_file}, got {session_file})"));
    }
    let message_count = state
        .get("messageCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if message_count <= 0 {
        return Err(format!("Reattach verification failed: messageCount is {message_count}, expected greater than 0"));
    }
    Ok(())
}

/// Builds the one-time notice for a message count that dropped on reattach, or `None` if it did not drop.
/// The count is re-baselined, not treated as a failure; the caller shows the notice once.
pub(super) fn reattach_rebaseline_notice(session: &Session, state: &Value) -> Option<String> {
    let last_message_count = session.last_message_count?;
    let message_count = state
        .get("messageCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if message_count >= last_message_count {
        return None;
    }
    Some(format!(
        "This conversation reconnected with {message_count} messages, down from the {last_message_count} last seen; the aborted or unsent trailing messages from before it stopped may account for the difference."
    ))
}

/// Lets the fetch logic run against a fake requester instead of a real `omp` process in tests.
trait MessagesPageRequester {
    async fn request_frame(&self, cmd: Value, timeout_ms: u64) -> Result<Value, String>;
}

impl MessagesPageRequester for OmpProcess {
    async fn request_frame(&self, cmd: Value, timeout_ms: u64) -> Result<Value, String> {
        self.request(cmd, timeout_ms)
            .await
            .map_err(|err| err.to_string())
    }
}

/// Pages through messages, falling back to one plain `get_messages` call if the first page fails.
/// Never fails outright; an incomplete fetch returns what was already collected.
pub(super) async fn fetch_all_messages(proc: &OmpProcess) -> (Vec<Value>, bool) {
    fetch_all_messages_core(proc).await
}

async fn fetch_all_messages_core<R: MessagesPageRequester>(proc: &R) -> (Vec<Value>, bool) {
    let mut all: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_MESSAGE_PAGES {
        let mut cmd = json!({ "type": "get_messages_page", "limit": MESSAGES_PAGE_SIZE });
        if let Some(cursor) = &cursor {
            cmd["cursor"] = Value::String(cursor.clone());
        }
        let res = match proc.request_frame(cmd, DEFAULT_REQUEST_TIMEOUT_MS).await {
            Ok(res) => res,
            Err(_) if page == 0 => return fallback_to_get_messages_core(proc).await,
            Err(_) => return (all, false),
        };
        if res.get("success").and_then(Value::as_bool) != Some(true) {
            if page == 0 {
                return fallback_to_get_messages_core(proc).await;
            }
            return (all, false);
        }
        let data = res.get("data");
        let messages = data
            .and_then(|d| d.get("messages"))
            .and_then(Value::as_array);
        let total_messages = data
            .and_then(|d| d.get("totalMessages"))
            .and_then(Value::as_u64);
        let (Some(messages), Some(total_messages)) = (messages, total_messages) else {
            if page == 0 {
                return fallback_to_get_messages_core(proc).await;
            }
            return (all, false);
        };
        let next_cursor = data
            .and_then(|d| d.get("nextCursor"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if next_cursor.is_some() && (messages.is_empty() || next_cursor == cursor) {
            return (all, false);
        }
        all.extend(messages.iter().cloned());
        if all.len() as u64 >= total_messages {
            return (all, true);
        }
        let Some(next_cursor) = next_cursor else {
            return (all, false);
        };
        cursor = Some(next_cursor);
    }
    (all, false)
}

async fn fallback_to_get_messages_core<R: MessagesPageRequester>(proc: &R) -> (Vec<Value>, bool) {
    let res = match proc
        .request_frame(
            json!({ "type": "get_messages" }),
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
    {
        Ok(res) => res,
        Err(_) => return (Vec::new(), false),
    };
    let messages = res
        .get("data")
        .and_then(|d| d.get("messages"))
        .and_then(Value::as_array);
    if res.get("success").and_then(Value::as_bool) != Some(true) || messages.is_none() {
        return (Vec::new(), false);
    }
    (messages.unwrap().clone(), true)
}

/// Probes `set_ask_dialog`, once per process. Any failure means the `select` fallback for the process lifetime (#572).
/// The caller shows any notice after the history merge, or the merge drops it.
pub(super) async fn send_set_ask_dialog(agent: &SessionAgent, proc: &OmpProcess) -> bool {
    let enabled = match proc
        .request(
            json!({ "type": "set_ask_dialog", "enabled": true }),
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
    {
        Ok(response) => {
            response
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && response
                    .get("data")
                    .and_then(|data| data.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        }
        Err(_) => false,
    };
    agent.state.lock().await.ask_dialog_enabled = enabled;
    enabled
}

/// Notice shown when `send_set_ask_dialog` resolved `enabled: false` (#572). Call it after the history merge.
pub(super) async fn append_ask_dialog_unavailable_notice(agent: &SessionAgent, enabled: bool) {
    if enabled {
        return;
    }
    agent
        .append_notice(
            "This version of the agent can't show its questions together, so they arrive one at a time."
                .to_string(),
            "info",
        )
        .await;
}

#[cfg(test)]
#[path = "launch_support.test.rs"]
mod tests;
