// `session::agent`'s own narrow error/status/pending-request types, split out of `mod.rs` itself
// (code-review finding, 2026-10-14: `mod.rs` was exactly 600 lines with no headroom left for the
// `session_id()` lane accessor). `mod.rs` re-exports all three
// (`pub use types::{AgentError, PendingRequest, SessionStatus}`), so every existing
// `crate::session::agent::{AgentError, SessionStatus}` (from `session/mod.rs`) and
// `super::{AgentError, PendingRequest, SessionStatus}` import across `session/agent/*` keeps
// resolving unchanged.

use serde::Serialize;

/// `src/shared/model.ts`'s own `SessionStatus` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Idle,
    Working,
    NeedsYou,
    Stopped,
}

/// Port of `exitVerdictGuard.ts`'s own `shouldApplyCrashExitVerdict`, narrowed to the
/// `statusNow !== 'stopped'` half of its two-part guard: the other half (`lifeEpochNow ===
/// epochAtExit`) guards a `restart()`/mode-change-respawn race this build does not implement
/// (see `mod.rs`'s own header: "no restart()/approval-mode-change auto-restart"), so there is no
/// `lifeEpoch` concept here for it to compare -- a real, intentional scope cut, not a silently
/// dropped port. Used by `mod.rs`'s own `set_stopped_unless_already_stopped` (`handle_exit`'s
/// crash branch): skips the verdict once something more authoritative (a synchronous `launch()`
/// failure path) already moved the Session to `stopped` for this same life.
pub(super) fn should_apply_crash_exit_verdict(status_now: SessionStatus) -> bool {
    status_now != SessionStatus::Stopped
}

#[cfg(test)]
mod exit_verdict_guard_tests {
    use super::{should_apply_crash_exit_verdict, SessionStatus};

    #[test]
    fn skips_the_verdict_once_already_stopped() {
        assert!(!should_apply_crash_exit_verdict(SessionStatus::Stopped));
    }

    #[test]
    fn applies_the_verdict_from_idle() {
        assert!(should_apply_crash_exit_verdict(SessionStatus::Idle));
    }

    #[test]
    fn applies_the_verdict_from_working() {
        assert!(should_apply_crash_exit_verdict(SessionStatus::Working));
    }

    #[test]
    fn applies_the_verdict_from_needs_you() {
        assert!(should_apply_crash_exit_verdict(SessionStatus::NeedsYou));
    }
}

/// Errors a `SessionAgent` method can produce; `code` matches one of `src/shared/ipc.ts`'s
/// `IpcErrorCode` values (`ipc::chat::map_chat_error`/`ipc::map_session_thrown`-equivalent
/// mapping happens at the IPC layer, not here).
#[derive(Debug)]
pub struct AgentError {
    pub code: &'static str,
    pub message: String,
}

impl AgentError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentError {}

/// `src/shared/model.ts`'s own `PendingRequest` union (`dialogs.ts`'s `classifyDialog` output).
/// `rename_all_fields` (not `rename_all`, which only renames variants) gives the camelCase field
/// names the renderer matches on (`requestId`, `optionDetails`, `inputKind`).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum PendingRequest {
    #[serde(rename = "approval")]
    Approval {
        request_id: String,
        tool: String,
        target: String,
        details: Vec<String>,
    },
    #[serde(rename = "question")]
    Question {
        request_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        options: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        option_details: Option<Vec<Option<String>>>,
        input_kind: &'static str,
    },
}

impl PendingRequest {
    // `pub(super)` (not private): `types` is now a sibling module of `frame`/`requests` rather
    // than the same module they used to share, so this needs to stay visible to all of
    // `session::agent` and its descendants, same reach it already had before the split.
    pub(super) fn request_id(&self) -> &str {
        match self {
            Self::Approval { request_id, .. } | Self::Question { request_id, .. } => request_id,
        }
    }
}
