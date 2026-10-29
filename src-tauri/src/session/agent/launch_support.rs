// Free functions `launch.rs`'s own `launch()`/`attach_and_verify()` need, plus the two other
// modules (`conversations.rs`, `requests.rs`) that reuse them -- split out of `launch.rs` (code
// review finding, round 4, 2026-10-14: pushed `launch.rs` to 609 lines, past issue #806's
// 600-line soft cap) so `launch.rs` keeps headroom under its own limit. No behaviour change:
// every function moved here verbatim. Port of `reattachVerification.ts`'s own `verifyReattach`
// and `fetchAllMessages.ts` -- see `launch.rs`'s own header for this module's place in the
// `agent/` split.

use serde_json::{json, Value};

use crate::omp::process::{ApprovalMode as ProcApprovalMode, OmpProcess};
use crate::store::registry::Session;
use crate::store::settings::ApprovalMode;

use super::{SessionAgent, DEFAULT_REQUEST_TIMEOUT_MS, MAX_MESSAGE_PAGES, MESSAGES_PAGE_SIZE};

/// `RegistryStoreError` has no `Display` impl (only its `Registry` variant's inner
/// `RegistryError` does); mirrors `ipc::map_registry_error`'s own match for the message half.
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

/// Also used by `agent::requests`'s own `pick_approval_target` to bound approval-dialog target
/// strings; kept here with the rest of this module's field-length truncation.
pub(super) fn truncate(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
}

/// Port of `reattachVerification.ts`'s own `assertConversationFileExists`: checked by
/// `attach_and_verify` before it ever calls `switch_session` (gate-fix round 4, test review
/// MEDIUM -- extracted out of `attach_and_verify`'s own inline `tokio::fs::metadata` check so
/// the missing-file error message is directly unit-testable, matching TS's own naming of the
/// path in the thrown message).
pub(super) async fn assert_conversation_file_exists(file: &str) -> Result<(), String> {
    if tokio::fs::metadata(file).await.is_err() {
        return Err(format!("Conversation file missing: {file}"));
    }
    Ok(())
}
/// Port of `reattachVerification.ts`'s own `verifyReattach`. Windows paths are compared
/// case-insensitively without canonicalisation (both sides are already absolute paths from the
/// registry/OMP itself, unlike `path.resolve`'s own relative-path handling).
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

/// Port of `reattachVerification.ts`'s own `reattachRebaselineNotice` (Constitution v1.9.0 /
/// FINDINGS item 44): when a reattach's observed `messageCount` comes back BELOW the Session's
/// last known count, this build re-baselines `lastMessageCount` to the observed value
/// (`sync_from_state`'s own job) rather than treating it as a failure -- see `verify_reattach`'s
/// own doc comment for why a drop is never itself a failure. The caller must tell the user this
/// happened, once, in product wording naming both counts; this only computes that text so it is
/// never fabricated ad hoc at the call site. Returns `None` when there is nothing to report (no
/// prior count, or the observed count did not drop).
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

/// Minimal seam `fetch_all_messages`/`fallback_to_get_messages` need to be unit-tested against a
/// plain fake instead of a real spawned `omp` process -- port of `fetchAllMessages.ts`'s own
/// `MessagesPageRequester` interface, and mirrors this lane's own earlier `ResumableAgent`/
/// `AttachableAgent` trait-extraction in `ipc/sessions_agent.rs`. `fetch_all_messages`'s public,
/// `&OmpProcess`-typed signature (every existing call site in `launch.rs`/`conversations.rs`) is
/// unchanged -- it is now a one-line adapter over the `_core` functions below, which take any
/// `R: MessagesPageRequester` and are what `launch_support.test.rs` exercises directly.
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

/// Port of `fetchAllMessages.ts`: bounded `get_messages_page` pagination, falling back to a
/// single plain `get_messages` call if the very first page fails. Never fails outright -- an
/// incomplete fetch (`complete: false`) returns whatever was already accumulated.
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

/// D1/D2 (#572): `set_ask_dialog{enabled:true}` probe, sent once per process right after
/// `launch()`'s own reattach verification. Result lives only in `agent.state`'s
/// `ask_dialog_enabled` (never persisted to the registry); anything but
/// `{success:true, data:{enabled:true}}` -- an error, a timeout, or any other response shape --
/// leaves Refract on the `select` fallback path for this process's life (D2), and only a later
/// reattach/relaunch (a new process, hence a fresh `launch()` call) re-probes. Returns the
/// resolved `enabled` value; the caller (not this function) decides whether and when to tell the
/// user, since appending a notice here -- before the history merge -- was gate-fix round 1 High
/// finding H3: `merge_from_history` keeps only unresolved requests and running/streaming items,
/// so a notice appended before it is silently dropped on every launch where the history fetch
/// completes.
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

/// D20 (#572): the one notice when `send_set_ask_dialog` above resolved `enabled: false`. Split
/// out of `launch.rs` (which was sitting at the 600-line cap with no headroom) purely to keep
/// that call site a one-liner; the caller still decides WHEN to call this (after the history
/// merge, never right after `send_set_ask_dialog` itself -- gate-fix round 1 High: an earlier
/// pass called `append_notice` before the merge, which silently dropped it every time).
pub(super) async fn append_ask_dialog_unavailable_notice(agent: &SessionAgent, enabled: bool) {
    if enabled {
        return;
    }
    agent
        .append_notice(
            "This version of OMP can't show an agent's questions together, so they arrive one at a time."
                .to_string(),
            "info",
        )
        .await;
}

#[cfg(test)]
#[path = "launch_support.test.rs"]
mod tests;
