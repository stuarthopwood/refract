// Right-panel terminal (spec 144, ADR 0016): every shell is a ConPTY child owned here, output streams to
// the renderer on a Tauri `Channel` passed as an argument of `refract_request`. This module is the only
// place that spawns a shell (`pty.rs`). No terminal bytes reach a logger or an error message.

pub mod frame;
pub mod guard;
pub mod handlers;
pub mod limits;
pub mod pty;
pub mod ring;
pub mod shell;
pub mod stream;
pub mod tab;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use self::limits::MAX_TABS_PER_SESSION;
use self::shell::ShellKind;
use self::tab::{StateNotifier, Tab, TabInfo, TabParams};
use crate::ipc::IpcError;

#[derive(Default)]
struct Tabs {
    /// Each Session's tabs in creation order.
    by_session: HashMap<String, Vec<Arc<Tab>>>,
    /// The tab the renderer last showed for a Session.
    active: HashMap<String, String>,
}

/// Owns every terminal tab of the running app.
#[derive(Default)]
pub struct TerminalManager {
    tabs: Mutex<Tabs>,
}

impl TerminalManager {
    fn tabs(&self) -> MutexGuard<'_, Tabs> {
        self.tabs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a tab to `session_id` and hands it to `start`, outside the lock because starting reports state.
    /// The tab is named `Terminal N` with the lowest N no tab of the Session uses.
    pub fn create(
        &self,
        session_id: &str,
        cwd: PathBuf,
        notify: StateNotifier,
        start: impl FnOnce(&Arc<Tab>),
    ) -> Result<TabInfo, IpcError> {
        let tab = {
            let mut tabs = self.tabs();
            let existing = tabs.by_session.entry(session_id.to_string()).or_default();
            if existing.len() >= MAX_TABS_PER_SESSION {
                return Err(IpcError::new(
                    "terminal-limit",
                    format!("A Session can have at most {MAX_TABS_PER_SESSION} terminals"),
                ));
            }
            let number = (1..)
                .find(|n| {
                    let name = format!("Terminal {n}");
                    existing.iter().all(|tab| tab.info().name != name)
                })
                .unwrap_or(1);
            let order = existing
                .iter()
                .map(|tab| tab.info().order + 1)
                .max()
                .unwrap_or(0);
            let tab = Tab::new(
                TabParams {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    name: format!("Terminal {number}"),
                    cwd,
                    shell: ShellKind::Powershell,
                    order,
                },
                notify,
            );
            existing.push(Arc::clone(&tab));
            tabs.active
                .insert(session_id.to_string(), tab.id().to_string());
            tab
        };
        start(&tab);
        Ok(tab.info())
    }

    /// The Session's tabs in order, and the one the renderer last showed (the first when none was shown).
    pub fn list(&self, session_id: &str) -> (Vec<TabInfo>, Option<String>) {
        let tabs = self.tabs();
        let mut infos: Vec<TabInfo> = tabs
            .by_session
            .get(session_id)
            .map(|list| list.iter().map(|tab| tab.info()).collect())
            .unwrap_or_default();
        infos.sort_by_key(|info| info.order);
        let active = tabs
            .active
            .get(session_id)
            .filter(|id| infos.iter().any(|info| &info.id == *id))
            .cloned()
            .or_else(|| infos.first().map(|info| info.id.clone()));
        (infos, active)
    }

    pub fn find(&self, tab_id: &str) -> Option<Arc<Tab>> {
        self.tabs()
            .by_session
            .values()
            .flatten()
            .find(|tab| tab.id() == tab_id)
            .cloned()
    }

    pub fn set_active(&self, session_id: &str, tab_id: &str) {
        self.tabs()
            .active
            .insert(session_id.to_string(), tab_id.to_string());
    }

    /// Kills every shell tree; the app-quit hook. Not wired yet (T025).
    pub fn shutdown_all(&self) {}

    /// Closes every tab of a deleted Session (FR-017). Not wired yet (T025).
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
