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
pub const SESSION_LIST_CHANGED: &str = "session:list-changed";
pub const TRANSCRIPT_PATCH: &str = "transcript:patch";
pub const QUEUE_UPDATE: &str = "queue:update";
pub const REQUEST_PENDING: &str = "request:pending";
pub const REQUEST_RESOLVED: &str = "request:resolved";
pub const COMMANDS_UPDATE: &str = "commands:update";
pub const SETTINGS_CHANGED: &str = "settings:changed";
pub const UI_OPEN_SESSION: &str = "ui:open-session";
pub const MEMORY_WARNING: &str = "memory:warning";
pub const READOUT_UPDATE: &str = "readout:update";
pub const SUBAGENTS_UPDATE: &str = "subagents:update";
pub const SUBAGENT_PATCH: &str = "subagent:patch";
pub const SIDE_CHAT_PATCH: &str = "side-chat:patch";
pub const SIDE_CHAT_INTERRUPTED: &str = "side-chat:interrupted";
pub const SIDE_CHAT_CONVERSATION_CHANGED: &str = "side-chat:conversation-changed";
pub const FILE_EXPLORER_PATCH: &str = "file-explorer:patch";
pub const FILE_EXPLORER_RESET: &str = "file-explorer:reset";
pub const ACCOUNTS_GITHUB_CHANGED: &str = "accounts:github-changed";
pub const ACCOUNTS_GITHUB_ADD_PROGRESS: &str = "accounts:github-add-progress";

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
