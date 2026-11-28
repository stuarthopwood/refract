// Right-panel terminal (spec 144, ADR 0016): every shell is a ConPTY child owned here, output streams to
// the renderer on a Tauri `Channel` passed as an argument of `refract_request`. This module is the only
// place that spawns a shell (`pty.rs`). No terminal bytes reach a logger or an error message.

pub mod frame;
pub mod guard;
pub mod limits;
pub mod pty;
pub mod ring;
pub mod shell;
pub mod stream;

use std::sync::LazyLock;

/// Owns every terminal tab of the running app. Tabs arrive with the handlers task; until then the
/// manager holds none, so the lifecycle hooks below have nothing to stop.
#[derive(Debug, Default)]
pub struct TerminalManager {}

impl TerminalManager {
    /// Kills every shell tree; the app-quit hook. No tabs exist yet.
    pub fn shutdown_all(&self) {}

    /// Closes every tab of a deleted Session (FR-017). No tabs exist yet.
    pub fn close_session(&self, _session_id: &str) {}
}

static MANAGER: LazyLock<TerminalManager> = LazyLock::new(TerminalManager::default);

/// The one manager of the running app; created on first use, so `run()` needs no init call.
pub fn manager() -> &'static TerminalManager {
    &MANAGER
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
