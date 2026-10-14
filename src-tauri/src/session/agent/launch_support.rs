// Free functions `launch.rs`'s own `launch()`/`attach_and_verify()` need, plus the two other
// modules (`conversations.rs`, `requests.rs`) that reuse them -- split out of `launch.rs` (code
// review finding, round 4, 2026-10-14: pushed `launch.rs` to 609 lines, past issue #806's
// 600-line soft cap) so `launch.rs` keeps headroom under its own limit. No behaviour change:
// every function moved here verbatim. Port of `reattachVerification.ts`'s own `verifyReattach`
// and `fetchAllMessages.ts` -- see `launch.rs`'s own header for this module's place in the
// `agent/` split.

use serde_json::{json, Value};

use crate::omp::process::{ApprovalMode as ProcApprovalMode, OmpProcess};
use crate::store::settings::ApprovalMode;

use super::{DEFAULT_REQUEST_TIMEOUT_MS, MAX_MESSAGE_PAGES, MESSAGES_PAGE_SIZE};

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
        ApprovalMode::EditFreely => ProcApprovalMode::EditFreely,
        ApprovalMode::Auto => ProcApprovalMode::Auto,
    }
}

/// Also used by `agent::requests`'s own `pick_approval_target` to bound approval-dialog target
/// strings; kept here with the rest of this module's field-length truncation.
pub(super) fn truncate(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
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

#[cfg(test)]
#[path = "launch_support.test.rs"]
mod tests;
