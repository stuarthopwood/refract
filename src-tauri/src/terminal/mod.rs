// Right-panel terminal (spec 144, ADR 0016): every shell is a ConPTY child owned here, output streams to
// the renderer on a Tauri `Channel` passed as an argument of `refract_request`. This module is the only
// place that spawns a shell (`pty.rs`). No terminal bytes reach a logger or an error message.

pub mod frame;
pub mod guard;
pub mod handlers;
pub mod limits;
pub mod persist;
pub mod pty;
pub mod ring;
pub mod shell;
pub mod stream;
pub mod tab;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use self::limits::MAX_TABS_PER_SESSION;
use self::persist::{SavedSession, SavedTab};
use self::shell::ShellKind;
use self::tab::{StateNotifier, Tab, TabInfo, TabParams};
use crate::ipc::IpcError;

#[derive(Default)]
struct Tabs {
    /// Each Session's tabs in creation order.
    by_session: HashMap<String, Vec<Arc<Tab>>>,
    /// The tab the renderer last showed for a Session.
    active: HashMap<String, String>,
    /// Sessions whose saved tabs were already offered this run, so they are restored at most once.
    restored: HashSet<String>,
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

    /// True the first time it is asked of `session_id` in this run: that is when the Session's saved tabs
    /// are restored (FR-016).
    pub fn claim_restore(&self, session_id: &str) -> bool {
        self.tabs().restored.insert(session_id.to_string())
    }

    /// Adds a fresh shell for each saved tab, keeping its id, name, folder and order. Starts them outside
    /// the lock, like `create`. Tabs past the limit, or whose id is already in use, are skipped.
    pub fn restore(
        &self,
        session_id: &str,
        saved: &SavedSession,
        notify: &StateNotifier,
        start: impl Fn(&Arc<Tab>),
    ) {
        let restored: Vec<Arc<Tab>> = {
            let mut tabs = self.tabs();
            let mut taken: HashSet<String> = tabs
                .by_session
                .values()
                .flatten()
                .map(|tab| tab.id().to_string())
                .collect();
            let existing = tabs.by_session.entry(session_id.to_string()).or_default();
            let mut made = Vec::new();
            for record in &saved.tabs {
                if existing.len() >= MAX_TABS_PER_SESSION || !taken.insert(record.id.clone()) {
                    continue;
                }
                let tab = Tab::new(
                    TabParams {
                        id: record.id.clone(),
                        session_id: session_id.to_string(),
                        name: record.name.clone(),
                        cwd: PathBuf::from(&record.cwd),
                        shell: ShellKind::parse_saved(&record.shell),
                        order: record.order,
                    },
                    Arc::clone(notify),
                );
                existing.push(Arc::clone(&tab));
                made.push(tab);
            }
            if let Some(active) = saved
                .active_tab_id
                .as_ref()
                .filter(|id| made.iter().any(|tab| tab.id() == id.as_str()))
            {
                tabs.active.insert(session_id.to_string(), active.clone());
            }
            made
        };
        for tab in &restored {
            start(tab);
        }
    }

    /// What would be saved for every Session that has a tab list this run; one whose tabs were all closed
    /// reports an empty list, which `persist::save_live` turns into dropping its record. A Session whose
    /// saved tabs are not restored yet is absent, so its record is left as it was.
    pub fn saved_sessions(&self) -> BTreeMap<String, SavedSession> {
        let tabs = self.tabs();
        tabs.by_session
            .keys()
            .map(|session_id| {
                let mut infos: Vec<TabInfo> = tabs
                    .by_session
                    .get(session_id)
                    .map(|list| list.iter().map(|tab| tab.info()).collect())
                    .unwrap_or_default();
                infos.sort_by_key(|info| info.order);
                let active_tab_id = tabs
                    .active
                    .get(session_id)
                    .filter(|id| infos.iter().any(|info| &info.id == *id))
                    .cloned();
                let saved_tabs = infos
                    .into_iter()
                    .map(|info| SavedTab {
                        id: info.id,
                        name: info.name,
                        cwd: info.cwd,
                        shell: info.shell.as_str().to_string(),
                        order: info.order,
                    })
                    .collect();
                (
                    session_id.clone(),
                    SavedSession {
                        active_tab_id,
                        tabs: saved_tabs,
                    },
                )
            })
            .collect()
    }

    /// Closes one tab (FR-012). Without `force`, a shell with a running child is left alone and the caller
    /// is told to ask the developer first (FR-013). A tab that is already gone counts as closed, so a double
    /// click on the close button is harmless.
    pub fn close(&self, tab_id: &str, force: bool) -> CloseOutcome {
        let Some(tab) = self.find(tab_id) else {
            return CloseOutcome::Closed;
        };
        if !force && tab.has_running_child() {
            return CloseOutcome::NeedsConfirm;
        }
        {
            let mut tabs = self.tabs();
            if let Some(list) = tabs.by_session.get_mut(tab.session_id()) {
                list.retain(|other| other.id() != tab_id);
            }
            if tabs.active.get(tab.session_id()).map(String::as_str) == Some(tab_id) {
                tabs.active.remove(tab.session_id());
            }
        }
        tab.close();
        CloseOutcome::Closed
    }

    /// Kills every shell tree and forgets every tab; the app-quit hook (FR-015). The saved tab list is left
    /// alone so the next launch restores it.
    pub fn shutdown_all(&self) {
        let all = {
            let mut tabs = self.tabs();
            tabs.active.clear();
            std::mem::take(&mut tabs.by_session)
        };
        for tab in all.into_values().flatten() {
            tab.close();
        }
    }

    /// Ends every shell of an archived or deleted Session (FR-014). The Session counts as restored from
    /// here on, so un-archiving it never brings its terminals back.
    pub fn close_session(&self, session_id: &str) {
        let removed = {
            let mut tabs = self.tabs();
            tabs.active.remove(session_id);
            tabs.restored.insert(session_id.to_string());
            tabs.by_session.remove(session_id).unwrap_or_default()
        };
        for tab in removed {
            tab.close();
        }
    }
}

/// What `terminal.close` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    Closed,
    NeedsConfirm,
}

/// Archive and delete: ends the Session's shells and forgets its saved tabs, so nothing revives it (FR-014).
pub async fn end_session(data_dir: &std::path::Path, session_id: &str) {
    manager().close_session(session_id);
    persist::forget_session(data_dir, session_id).await;
}

static MANAGER: LazyLock<TerminalManager> = LazyLock::new(TerminalManager::default);

/// The one manager of the running app; created on first use, so `run()` needs no init call.
pub fn manager() -> &'static TerminalManager {
    &MANAGER
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
