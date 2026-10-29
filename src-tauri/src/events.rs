// Tauri event names, ported 1:1 from `src/shared/ipc.ts`'s `IPC_EVENTS` (FR-008): the Rust
// backend emits under these exact string values, with the same JSON payload shapes the Electron
// build sends on the matching channel, so `src/renderer` (unchanged) subscribes identically
// against either backend. Milestone 1 (spec.md FR-013) only ever emits the eight constants a
// later slice's own module (`session`, `omp`) actually calls `emit` with; every other constant
// below exists only so a later slice never has to re-derive the exact string from
// `src/shared/ipc.ts` by hand.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::omp::diff::TranscriptOp;
use crate::store::registry::RegistryStore;

pub const SESSION_STATUS: &str = "session:status";
pub const SESSION_ACTIVITY: &str = "session:activity";
pub const SESSION_LIST_CHANGED: &str = "session:list-changed";
pub const TRANSCRIPT_PATCH: &str = "transcript:patch";
pub const QUEUE_UPDATE: &str = "queue:update";
pub const REQUEST_PENDING: &str = "request:pending";
pub const REQUEST_RESOLVED: &str = "request:resolved";
pub const COMMANDS_UPDATE: &str = "commands:update";
pub const SETTINGS_CHANGED: &str = "settings:changed";
pub const UI_OPEN_SESSION: &str = "ui:open-session";
pub const MEMORY_WARNING: &str = "memory:warning";
pub const TOKEN_GUARD_LAUNCH_WARNING: &str = "token-guard:launch-warning";
pub const TOKEN_GUARD_CALLS: &str = "token-guard:calls";
pub const READOUT_UPDATE: &str = "readout:update";
pub const ADVISOR_UPDATE: &str = "advisor:update";
pub const SESSION_HEALTH: &str = "session:health";
pub const SUBAGENTS_UPDATE: &str = "subagents:update";
pub const SUBAGENT_PATCH: &str = "subagent:patch";
pub const SIDE_CHAT_PATCH: &str = "side-chat:patch";
pub const SIDE_CHAT_INTERRUPTED: &str = "side-chat:interrupted";
pub const SIDE_CHAT_CONVERSATION_CHANGED: &str = "side-chat:conversation-changed";
pub const FILE_EXPLORER_PATCH: &str = "file-explorer:patch";
pub const FILE_EXPLORER_RESET: &str = "file-explorer:reset";
// Spec 018 (issue #464): the Git changes panel's own watcher-driven refresh ping (FR-015b) --
// no diff content, matching `FILE_EXPLORER_RESET`'s own minimal payload; the renderer always
// calls `gitChanges.list` again itself rather than applying a patch.
pub const GIT_CHANGES_REFRESH: &str = "git-changes:refresh";
pub const ACCOUNTS_GITHUB_CHANGED: &str = "accounts:github-changed";
pub const ACCOUNTS_GITHUB_ADD_PROGRESS: &str = "accounts:github-add-progress";
// Lane R11b (issue #794, spec 006 "Installer and updates").
pub const READINESS_INSTALL_PROGRESS: &str = "readiness:install-progress";
pub const READINESS_CHANGED: &str = "readiness:changed";
pub const UPDATES_STATE_CHANGED: &str = "updates:state-changed";

/// Wire-identical to `transcript:patch`'s payload shape (`{ sessionId, ops }`), borrowed instead
/// of built through `serde_json::Value` (performance finding, 2026-10-13): lets `app.emit`
/// serialise straight from `ops` in one pass instead of two extra `Value`-tree copies first.
#[derive(Clone, Serialize)]
struct TranscriptPatchPayload<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    ops: &'a [TranscriptOp],
}

/// The milestone-1 event fan-out (tasks.md T027, `src/main/ipc/register.ts`'s own
/// `forwardEvent` plus `broadcast.ts`'s `broadcastSettingsChanged`): one typed emit method per
/// event this build actually fires, each a thin wrapper over `emit` below. Cheap to clone (one
/// `Arc`), so every `session::agent::SessionAgent`/`session::manager::SessionManager` instance
/// holds its own copy instead of threading an `&AppHandle` through every method signature --
/// `app_handle` is `None` until `lib.rs`'s `setup` closure runs; every method here silently
/// no-ops until then, the same "no window yet, drop it" stance `forwardEvent` takes.
#[derive(Clone)]
pub struct EventSink {
    app_handle: std::sync::Arc<std::sync::Mutex<Option<AppHandle>>>,
    // Lane R10b, issue #793: `shell::notifications::on_session_status` (called from
    // `emit_session_status` below) needs a live Session's display name, which lives only in the
    // registry -- `EventSink` otherwise has no reason to know about any store.
    registry: std::sync::Arc<tokio::sync::Mutex<RegistryStore>>,
}

impl EventSink {
    pub fn new(
        app_handle: std::sync::Arc<std::sync::Mutex<Option<AppHandle>>>,
        registry: std::sync::Arc<tokio::sync::Mutex<RegistryStore>>,
    ) -> Self {
        Self {
            app_handle,
            registry,
        }
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

    /// `session:status`: `payload` is a `session::agent::SessionStatusEvent` already serialised
    /// to `Value` by the caller (kept generic here so `events.rs` never needs to depend on
    /// `session`, avoiding a module cycle). Also the one hook OS notifications fire from (issue
    /// #793): every status transition already flows through this exact method, the Rust
    /// equivalent of the chokepoint Electron's own `SessionManager.onEvent` gives
    /// `registerNotifications` for free.
    pub fn emit_session_status(&self, payload: &serde_json::Value) {
        self.send(SESSION_STATUS, payload.clone());
        crate::shell::notifications::on_session_status(
            self.app_handle.clone(),
            self.registry.clone(),
            payload.clone(),
        );
    }

    /// `session:activity` (issue #526, FR-108/FR-109): one Session row's Activity line inputs,
    /// `null` when the Session is not working. Throttled by `session::readout`'s activity
    /// emitter; the payload carries agent text, so it is never logged.
    pub fn emit_session_activity(&self, session_id: &str, activity: serde_json::Value) {
        self.send(
            SESSION_ACTIVITY,
            serde_json::json!({ "sessionId": session_id, "activity": activity }),
        );
    }

    /// `session:list-changed`: no payload, matching `window.webContents.send(IPC_EVENTS.
    /// SESSION_LIST_CHANGED)`'s own no-argument call. Also the hook `shell::notifications`'
    /// `LAST_STATUS` map prunes stale Session ids from (gate fix, issue #793): archive, restore,
    /// delete and recreate all already fire this event.
    pub fn emit_session_list_changed(&self) {
        self.send(SESSION_LIST_CHANGED, ());
        crate::shell::notifications::prune_deleted_sessions(self.registry.clone());
    }

    /// Serialises `ops` directly from a borrowed `TranscriptPatchPayload` (performance finding,
    /// 2026-10-13): the caller used to build a `serde_json::Value` tree via `to_value(&ops)` and
    /// this method then rewrapped that `Value` through another `json!()` call -- two extra full
    /// copies of the patch on top of the one `app.emit` itself must do to reach the webview.
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

    /// `settings:changed` (`ipc/broadcast.ts`'s own `broadcastSettingsChanged`): the whole
    /// `Settings` row, already serialised by the caller.
    pub fn emit_settings_changed(&self, settings: &serde_json::Value) {
        self.send(SETTINGS_CHANGED, settings.clone());
    }

    /// `readiness:install-progress` (lane R11b, issue #794): drives the Install button's
    /// progress and outcome text on the first-run readiness screen.
    pub fn emit_readiness_install_progress(&self, progress: &serde_json::Value) {
        self.send(READINESS_INSTALL_PROGRESS, progress.clone());
    }

    /// `readiness:changed` (lane R11b, issue #794): pushed after
    /// `readiness.installDependency` finishes its own automatic re-check, so the caller does
    /// not need to call `readiness.check()` itself to pick up the result.
    pub fn emit_readiness_changed(&self, readiness: &serde_json::Value) {
        self.send(READINESS_CHANGED, readiness.clone());
    }

    /// `updates:state-changed` (lane R11b, issue #794): drives the update badge in the status
    /// bar. The whole `UpdateState` row, already serialised and already stripped of its
    /// main-only `installerPath` by the caller (`ipc::updates`'s own `to_renderer_state`).
    pub fn emit_updates_state_changed(&self, state: &serde_json::Value) {
        self.send(UPDATES_STATE_CHANGED, state.clone());
    }

    /// `memory:warning` (lane R5, issue #788): `shell::memory`'s own low-memory sampler, pushed
    /// only on a low/not-low state change or once a minute while it stays low (never every
    /// sample). Mirrors `memory.ts`'s own `window.webContents.send(IPC_EVENTS.MEMORY_WARNING, ...)`.
    pub fn emit_memory_warning(&self, low: bool, free_bytes: u64, live_agents: usize) {
        self.send(
            MEMORY_WARNING,
            serde_json::json!({ "low": low, "freeBytes": free_bytes, "liveAgents": live_agents }),
        );
    }

    /// `token-guard:launch-warning` (#1212): the overlay or rules file could not be written, so
    /// this launch runs without the failed argument.
    pub fn emit_token_guard_warning(&self, session_id: &str, reason: &str) {
        self.send(
            TOKEN_GUARD_LAUNCH_WARNING,
            &serde_json::json!({ "sessionId": session_id, "reason": reason }),
        );
    }

    /// `token-guard:calls` (#1212): the model-call count of a Session's current Conversation.
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

    /// `readout:update` (lane R5, issue #788): the chip row's live `SessionReadout` bundle
    /// (`session::readout`'s own `assemble_readout`), debounced/single-flight there.
    pub fn emit_readout_update(&self, session_id: &str, readout: serde_json::Value) {
        self.send(
            READOUT_UPDATE,
            serde_json::json!({ "sessionId": session_id, "readout": readout }),
        );
    }

    /// `advisor:update` (issue #937): the composer status line's Advisor chip on/off state,
    /// session-scoped (`session::advisor`'s own state, sourced from `/advisor on|off`'s own
    /// reply text plus a silent `/advisor status` probe at attach/resume -- see that module's
    /// own header for why `/advisor status`'s own reply is not trusted the same way).
    pub fn emit_advisor_update(&self, session_id: &str, advisor_on: bool) {
        self.send(
            ADVISOR_UPDATE,
            serde_json::json!({ "sessionId": session_id, "advisorOn": advisor_on }),
        );
    }

    /// `session:health` (issue #561): the Session's degraded-only health readouts. A field is
    /// `null` while that measure is healthy; both `null` means nothing to show.
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

    /// `subagents:update` (lane R5, issue #788): the Session's current `SubagentSummary[]`
    /// (`session::subagents`'s own list, which -- unlike the ported-fixed-not-the-bug Electron
    /// heuristic, issue #712 -- persists across turns until a new Conversation starts).
    pub fn emit_subagents_update(&self, session_id: &str, subagents: serde_json::Value) {
        self.send(
            SUBAGENTS_UPDATE,
            serde_json::json!({ "sessionId": session_id, "subagents": subagents }),
        );
    }

    /// `subagent:patch` (lane R5, issue #788): live `TranscriptOp[]` for the ONE subagent
    /// `chat.setVisibleSubagent` currently selects (`session::subagents`'s own per-id stream
    /// diff), mirroring `transcript:patch`'s own `{ sessionId, ops }` shape plus the subagent id.
    pub fn emit_subagent_patch(&self, session_id: &str, subagent_id: &str, ops: serde_json::Value) {
        self.send(
            SUBAGENT_PATCH,
            serde_json::json!({ "sessionId": session_id, "subagentId": subagent_id, "ops": ops }),
        );
    }

    /// `side-chat:patch` (lane R6, issue #789): a `btw_delta` (`delta`/`recordId` set -- gated on
    /// visibility by the caller, `session::side_chat`'s own `on_frame`, the same discipline every
    /// other live-stream patch follows).
    pub fn emit_side_chat_patch_delta(&self, session_id: &str, delta: &str, record_id: &str) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "delta": delta, "recordId": record_id }),
        );
    }

    /// `side-chat:patch` (lane R6, issue #789): a terminal `btw_record` (`record` set) --
    /// gate-fix round 2 Verif2 LOW: forwarded regardless of visibility, by the caller never
    /// gating this one.
    pub fn emit_side_chat_patch_record(&self, session_id: &str, record: &serde_json::Value) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "record": record }),
        );
    }

    /// `side-chat:patch` (lane R6, issue #789): a `btw-history` save-failure notice (`notice`
    /// set) -- gate-fix round 4 Code4 Medium: forwarded regardless of visibility.
    pub fn emit_side_chat_patch_notice(&self, session_id: &str, notice: &str) {
        self.send(
            SIDE_CHAT_PATCH,
            serde_json::json!({ "sessionId": session_id, "notice": notice }),
        );
    }

    /// `side-chat:interrupted` (lane R6, issue #789): fired unconditionally on every process
    /// exit (`session::side_chat`'s own `on_exit`), regardless of visibility.
    pub fn emit_side_chat_interrupted(&self, session_id: &str) {
        self.send(
            SIDE_CHAT_INTERRUPTED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    /// `side-chat:conversation-changed` (lane R6, issue #789): fired from
    /// `session::side_chat::on_conversation_reset`, regardless of visibility -- any side-chat
    /// topic/history the renderer is still showing belongs to the PREVIOUS Conversation.
    pub fn emit_side_chat_conversation_changed(&self, session_id: &str) {
        self.send(
            SIDE_CHAT_CONVERSATION_CHANGED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }
}

/// Emits `event` with `payload` to every window, mirroring the Electron build's own
/// `webContents.send(channel, payload)` broadcasts (FR-008). Logs rather than panics on
/// failure -- a dropped event (for example, no window yet) must never crash the backend, the
/// same defensive stance the dispatcher (`ipc::Dispatcher::dispatch`) takes for a handler error.
pub fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("refract-tauri: failed to emit {event}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lane R8 (#791) gate-fix: `emit_settings_changed`'s one real behaviour this lane depends on
    /// is reaching `send` with the exact `SETTINGS_CHANGED` event name and an unchanged clone of
    /// its payload -- the "no window yet" branch inside `send` (no `AppHandle` set) must never
    /// panic, since a settings setter can run before `lib.rs`'s `setup` closure has filled one in.
    #[tokio::test]
    async fn emit_settings_changed_does_not_panic_before_a_window_exists() {
        let dir =
            std::env::temp_dir().join(format!("refract-events-test-{}", uuid::Uuid::new_v4()));
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
