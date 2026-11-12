// Values must match `src/shared/ipc.ts`'s `IPC_EVENTS` exactly, or the renderer stops receiving them.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::omp::diff::TranscriptOp;
use crate::store::registry::RegistryStore;

pub const SESSION_STATUS: &str = "session:status";
pub const SESSION_ACTIVITY: &str = "session:activity";
pub const SESSION_LIST_CHANGED: &str = "session:list-changed";
/// Background `sessions.delete` finished: `{ sessionId }`.
pub const SESSION_DELETED: &str = "sessions:deleted";
/// Background `sessions.delete` failed: `{ sessionId, error: { code, message } }`.
pub const SESSION_DELETE_FAILED: &str = "sessions:delete-failed";
pub const TRANSCRIPT_PATCH: &str = "transcript:patch";
pub const QUEUE_UPDATE: &str = "queue:update";
pub const REQUEST_PENDING: &str = "request:pending";
pub const REQUEST_RESOLVED: &str = "request:resolved";
pub const COMMANDS_UPDATE: &str = "commands:update";
pub const SETTINGS_CHANGED: &str = "settings:changed";
pub const ALARM_FIRED: &str = "alarm:fired";
pub const UI_OPEN_SESSION: &str = "ui:open-session";
pub const MEMORY_WARNING: &str = "memory:warning";
pub const TOKEN_GUARD_LAUNCH_WARNING: &str = "token-guard:launch-warning";
pub const TOKEN_GUARD_CALLS: &str = "token-guard:calls";
pub const ADVISOR_ROSTER_DETECTED: &str = "advisor-roster:detected";
pub const READOUT_UPDATE: &str = "readout:update";
pub const ADVISOR_UPDATE: &str = "advisor:update";
pub const PREWALK_UPDATE: &str = "prewalk:update";
pub const SESSION_HEALTH: &str = "session:health";
pub const SUBAGENTS_UPDATE: &str = "subagents:update";
pub const SUBAGENT_PATCH: &str = "subagent:patch";
pub const AGENT_TOOLS_CALL: &str = "agent-tools:call";
pub const SIDE_CHAT_PATCH: &str = "side-chat:patch";
pub const SIDE_CHAT_INTERRUPTED: &str = "side-chat:interrupted";
pub const SIDE_CHAT_CONVERSATION_CHANGED: &str = "side-chat:conversation-changed";
pub const FILE_EXPLORER_PATCH: &str = "file-explorer:patch";
pub const FILE_EXPLORER_RESET: &str = "file-explorer:reset";
// Payload-free ping; the renderer re-lists changes itself.
pub const GIT_CHANGES_REFRESH: &str = "git-changes:refresh";
pub const ACCOUNTS_GITHUB_CHANGED: &str = "accounts:github-changed";
/// A PR or issue was merged, closed, created or edited: `{ repositoryId?, kind: 'pr' | 'issue', number }`.
pub const GITHUB_CHANGED: &str = "github:changed";
pub const ACCOUNTS_GITHUB_ADD_PROGRESS: &str = "accounts:github-add-progress";
pub const READINESS_INSTALL_PROGRESS: &str = "readiness:install-progress";
pub const READINESS_CHANGED: &str = "readiness:changed";
pub const UPDATES_STATE_CHANGED: &str = "updates:state-changed";
/// `usage:progress`, emitted by `ipc::usage`.
pub const USAGE_PROGRESS: &str = "usage:progress";

/// Clone progress and terminal events, `{ cloneId, phase, ... }`.
pub const REPOSITORIES_CLONE_PROGRESS: &str = "repositories:clone-progress";

/// Borrowed so `app.emit` serialises `ops` in one pass, with no `serde_json::Value` copy.
#[derive(Clone, Serialize)]
struct TranscriptPatchPayload<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    ops: &'a [TranscriptOp],
}

/// Shared across clones, so a probe set on the agent's sink is seen by every holder.
#[cfg(test)]
type StatusProbe = std::sync::Arc<std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>>;

/// One typed emit method per event this build fires. Cheap to clone, so each holder keeps its own
/// copy. Emits no-op until `lib.rs`'s `setup` fills `app_handle`.
#[derive(Clone)]
pub struct EventSink {
    app_handle: std::sync::Arc<std::sync::Mutex<Option<AppHandle>>>,
    // OS notifications resolve a Session's display name from the registry.
    registry: std::sync::Arc<tokio::sync::Mutex<RegistryStore>>,
    #[cfg(test)]
    status_probe: StatusProbe,
}

impl EventSink {
    pub fn new(
        app_handle: std::sync::Arc<std::sync::Mutex<Option<AppHandle>>>,
        registry: std::sync::Arc<tokio::sync::Mutex<RegistryStore>>,
    ) -> Self {
        Self {
            app_handle,
            registry,
            #[cfg(test)]
            status_probe: Default::default(),
        }
    }

    /// Test seam: runs at every `session:status` emit, so a test can observe the emitter's lock state.
    #[cfg(test)]
    pub(crate) fn set_status_probe(&self, probe: impl Fn() + Send + Sync + 'static) {
        *self.status_probe.lock().unwrap() = Some(std::sync::Arc::new(probe));
    }

    pub(crate) fn send<P: Serialize + Clone>(&self, event: &str, payload: P) {
        let handle = self
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        if let Some(app) = handle {
            emit(&app, event, payload);
        }
    }

    /// `session:status`. Also the OS-notification hook; `payload` is pre-serialised to avoid a
    /// module cycle with `session`.
    pub fn emit_session_status(&self, payload: &serde_json::Value) {
        #[cfg(test)]
        if let Some(probe) = self.status_probe.lock().unwrap().as_ref() {
            probe();
        }
        self.send(SESSION_STATUS, payload.clone());
        crate::shell::notifications::on_session_status(
            self.app_handle.clone(),
            self.registry.clone(),
            payload.clone(),
        );
    }

    /// `session:activity`: `activity` is `null` when the Session is idle. Carries agent text, so never log it.
    pub fn emit_session_activity(&self, session_id: &str, activity: serde_json::Value) {
        self.send(
            SESSION_ACTIVITY,
            serde_json::json!({ "sessionId": session_id, "activity": activity }),
        );
    }

    /// `session:list-changed`, no payload. Also prunes stale Session ids from the notification status map.
    pub fn emit_session_list_changed(&self) {
        self.send(SESSION_LIST_CHANGED, ());
        crate::shell::notifications::prune_deleted_sessions(self.registry.clone());
    }

    /// `sessions:deleted`: the background removal finished and the registry entry is gone.
    pub fn emit_session_deleted(&self, session_id: &str) {
        self.send(
            SESSION_DELETED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    /// `github:changed`: the renderer refreshes its PR and issue lists in the background.
    pub fn emit_github_changed(&self, repository_id: Option<&str>, kind: &str, number: u64) {
        self.send(
            GITHUB_CHANGED,
            github_changed_payload(repository_id, kind, number),
        );
    }

    /// `sessions:delete-failed`: the background removal failed; the registry entry is kept.
    pub fn emit_session_delete_failed(&self, session_id: &str, code: &str, message: &str) {
        self.send(
            SESSION_DELETE_FAILED,
            serde_json::json!({
                "sessionId": session_id,
                "error": { "code": code, "message": message },
            }),
        );
    }

    /// Serialises `ops` from a borrowed payload, avoiding a `serde_json::Value` copy.
    pub fn emit_transcript_patch(&self, session_id: &str, ops: &[TranscriptOp]) {
        self.send(TRANSCRIPT_PATCH, TranscriptPatchPayload { session_id, ops });
    }

    pub fn emit_queue_update(&self, session_id: &str, follow_up: &[String], steering: &[String]) {
        self.send(QUEUE_UPDATE, serde_json::json!({ "sessionId": session_id, "followUp": follow_up, "steering": steering }));
    }

    pub fn emit_request_pending(&self, session_id: &str, request: &serde_json::Value) {
        self.send(
            REQUEST_PENDING,
            serde_json::json!({ "sessionId": session_id, "request": request }),
        );
    }

    pub fn emit_request_resolved(&self, session_id: &str, request_id: &str) {
        self.send(
            REQUEST_RESOLVED,
            serde_json::json!({ "sessionId": session_id, "requestId": request_id }),
        );
    }

    pub fn emit_commands_update(&self, session_id: &str, commands: &serde_json::Value) {
        self.send(
            COMMANDS_UPDATE,
            serde_json::json!({ "sessionId": session_id, "commands": commands }),
        );
    }

    /// `settings:changed`: the whole serialised `Settings` row.
    pub fn emit_settings_changed(&self, settings: &serde_json::Value) {
        self.send(SETTINGS_CHANGED, settings.clone());
    }

    /// `readiness:install-progress`: drives the first-run Install button.
    pub fn emit_readiness_install_progress(&self, progress: &serde_json::Value) {
        self.send(READINESS_INSTALL_PROGRESS, progress.clone());
    }

    /// `readiness:changed`: pushed after the automatic re-check, so callers need not re-check.
    pub fn emit_readiness_changed(&self, readiness: &serde_json::Value) {
        self.send(READINESS_CHANGED, readiness.clone());
    }

    /// `updates:state-changed`: drives the status-bar update badge. The caller strips `installerPath`.
    pub fn emit_updates_state_changed(&self, state: &serde_json::Value) {
        self.send(UPDATES_STATE_CHANGED, state.clone());
    }

    /// `memory:warning`: sent on a low-state change, or once a minute while low.
    pub fn emit_memory_warning(&self, low: bool, free_bytes: u64, live_agents: usize) {
        self.send(
            MEMORY_WARNING,
            serde_json::json!({ "low": low, "freeBytes": free_bytes, "liveAgents": live_agents }),
        );
    }

    /// `token-guard:launch-warning`: the overlay or rules file failed to write, so this launch runs without it.
    pub fn emit_token_guard_warning(&self, session_id: &str, reason: &str) {
        self.send(
            TOKEN_GUARD_LAUNCH_WARNING,
            &serde_json::json!({ "sessionId": session_id, "reason": reason }),
        );
    }

    /// `token-guard:calls`: model-call count for the current Conversation.
    pub fn emit_token_guard_calls(&self, session_id: &str, conversation_id: &str, calls: u32) {
        self.send(
            TOKEN_GUARD_CALLS,
            serde_json::json!({
                "sessionId": session_id,
                "conversationId": conversation_id,
                "calls": calls
            }),
        );
    }

    /// `advisor-roster:detected`: a WATCHDOG.yml roster was found at this Session's launch.
    pub fn emit_advisor_roster_detected(
        &self,
        session_id: &str,
        roster: &crate::omp::advisor_roster::Roster,
    ) {
        self.send(
            ADVISOR_ROSTER_DETECTED,
            serde_json::json!({ "sessionId": session_id, "roster": roster }),
        );
    }

    /// `readout:update`: the chip row's `SessionReadout` bundle.
    pub fn emit_readout_update(&self, session_id: &str, readout: serde_json::Value) {
        self.send(
            READOUT_UPDATE,
            serde_json::json!({ "sessionId": session_id, "readout": readout }),
        );
    }

    /// `advisor:update`: the Advisor chip state. Set from `/advisor` replies, not `/advisor status`.
    pub fn emit_advisor_update(&self, session_id: &str, advisor_on: bool) {
        self.send(
            ADVISOR_UPDATE,
            serde_json::json!({ "sessionId": session_id, "advisorOn": advisor_on }),
        );
    }

    /// `prewalk:update`: `armed`, `off` or `unknown`, only ever from OMP's own prewalk replies.
    pub fn emit_prewalk_update(&self, session_id: &str, state: &str) {
        self.send(
            PREWALK_UPDATE,
            serde_json::json!({ "sessionId": session_id, "state": state }),
        );
    }

    /// `session:health`: degraded-only readouts; a `null` field is healthy.
    pub fn emit_session_health(
        &self,
        session_id: &str,
        rpc_slow_ms: Option<u64>,
        agent_memory_bytes: Option<u64>,
    ) {
        self.send(
            SESSION_HEALTH,
            serde_json::json!({
                "sessionId": session_id,
                "rpcSlowMs": rpc_slow_ms,
                "agentMemoryBytes": agent_memory_bytes,
            }),
        );
    }

    /// `subagents:update`: the Session's `SubagentSummary[]`, kept until a new Conversation starts.
    pub fn emit_subagents_update(&self, session_id: &str, subagents: serde_json::Value) {
        self.send(
            SUBAGENTS_UPDATE,
            serde_json::json!({ "sessionId": session_id, "subagents": subagents }),
        );
    }

    /// `subagent:patch`: live `TranscriptOp[]` for the one visible subagent.
    pub fn emit_subagent_patch(&self, session_id: &str, subagent_id: &str, ops: serde_json::Value) {
        self.send(
            SUBAGENT_PATCH,
            serde_json::json!({ "sessionId": session_id, "subagentId": subagent_id, "ops": ops }),
        );
    }

    /// `side-chat:patch`: a streamed delta, gated on visibility by the caller.
    pub fn emit_side_chat_patch_delta(&self, session_id: &str, delta: &str, record_id: &str) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "delta": delta, "recordId": record_id }),
        );
    }

    /// `side-chat:patch`: a terminal record, always forwarded regardless of visibility.
    pub fn emit_side_chat_patch_record(&self, session_id: &str, record: &serde_json::Value) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "record": record }),
        );
    }

    /// `side-chat:patch`: a save-failure notice, always forwarded.
    pub fn emit_side_chat_patch_notice(&self, session_id: &str, notice: &str) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "notice": notice }),
        );
    }

    /// `side-chat:interrupted`: fired on every process exit, regardless of visibility.
    pub fn emit_side_chat_interrupted(&self, session_id: &str) {
        self.send(
            SIDE_CHAT_INTERRUPTED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    /// `side-chat:conversation-changed`: any side-chat history shown belongs to the old Conversation.
    pub fn emit_side_chat_conversation_changed(&self, session_id: &str) {
        self.send(
            SIDE_CHAT_CONVERSATION_CHANGED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    /// `agent-tools:call`; false when there is no window to receive it.
    pub fn emit_agent_tools_call(
        &self,
        session_id: &str,
        call_id: &str,
        tool: &str,
        args: &serde_json::Value,
    ) -> bool {
        let has_window = self
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .is_some();
        if has_window {
            self.send(
                AGENT_TOOLS_CALL,
                serde_json::json!({ "sessionId": session_id, "callId": call_id, "tool": tool, "args": args }),
            );
        }
        has_window
    }
}

/// Emits to every window. Logs rather than panics, so a dropped event never crashes the backend.
pub fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("refract-tauri: failed to emit {event}: {err}");
    }
}

fn github_changed_payload(
    repository_id: Option<&str>,
    kind: &str,
    number: u64,
) -> serde_json::Value {
    serde_json::json!({ "repositoryId": repository_id, "kind": kind, "number": number })
}

/// Same event for IPC handlers, which hold an `AppHandle` and no `EventSink`.
pub fn emit_github_changed(app: &AppHandle, repository_id: Option<&str>, kind: &str, number: u64) {
    emit(
        app,
        GITHUB_CHANGED,
        github_changed_payload(repository_id, kind, number),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Must not panic before the `setup` closure has set an `AppHandle`.
    #[tokio::test]
    async fn emit_settings_changed_does_not_panic_before_a_window_exists() {
        let dir =
            crate::test_scratch::path(format!("refract-events-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let registry = RegistryStore::open(&dir).await.unwrap();
        let sink = EventSink::new(
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Mutex::new(registry)),
        );
        let payload = serde_json::json!({ "theme": "obsidian" });
        sink.emit_settings_changed(&payload);
    }
}
