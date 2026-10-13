// Tauri event names, ported 1:1 from `src/shared/ipc.ts`'s `IPC_EVENTS` (FR-008): the Rust
// backend emits under these exact string values, with the same JSON payload shapes the Electron
// build sends on the matching channel, so `src/renderer` (unchanged) subscribes identically
// against either backend. Milestone 1 (spec.md FR-013) only ever emits the eight constants a
// later slice's own module (`session`, `omp`) actually calls `emit` with; every other constant
// below exists only so a later slice never has to re-derive the exact string from
// `src/shared/ipc.ts` by hand.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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

/// Emits `event` with `payload` to every window, mirroring the Electron build's own
/// `webContents.send(channel, payload)` broadcasts (FR-008). Logs rather than panics on
/// failure -- a dropped event (for example, no window yet) must never crash the backend, the
/// same defensive stance the dispatcher (`ipc::Dispatcher::dispatch`) takes for a handler error.
pub fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("refract-tauri: failed to emit {event}: {err}");
    }
}
