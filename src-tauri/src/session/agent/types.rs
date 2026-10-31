// Error, status, and pending-request types for `session::agent`. `mod.rs` re-exports them.

use serde::Serialize;

/// Mirrors the renderer's `SessionStatus` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Idle,
    Working,
    NeedsYou,
    Stopped,
}

/// Skips the crash verdict when the Session already moved to `stopped` for this life.
/// The stale-life check lives in `handle_exit` (`is_current`), not here.
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

/// Errors a `SessionAgent` method can produce. `code` matches an `IpcErrorCode` value.
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

/// Mirrors the renderer's `PendingRequest` union. `rename_all_fields` gives camelCase fields.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question of a `PendingRequest::Ask`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<AskOption>,
    pub multi: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum PendingRequest {
    #[serde(rename = "approval")]
    Approval {
        request_id: String,
        tool: String,
        target: String,
        details: Vec<String>,
        /// Option labels in OMP's order; answered verbatim (#1140).
        options: Vec<String>,
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
        /// OMP 18.13.2 `secret: true`: the renderer masks the field and never echoes the answer.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        secret: bool,
    },
    #[serde(rename = "ask")]
    Ask {
        request_id: String,
        questions: Vec<AskQuestion>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deadline_at: Option<i64>,
    },
}

impl PendingRequest {
    // `pub(super)`: sibling modules of `session::agent` need access.
    pub(super) fn request_id(&self) -> &str {
        match self {
            Self::Approval { request_id, .. }
            | Self::Question { request_id, .. }
            | Self::Ask { request_id, .. } => request_id,
        }
    }
}
