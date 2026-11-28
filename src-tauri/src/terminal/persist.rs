// The one thing the terminal saves: each Session's tab list (name, working folder, shell kind, order) in
// `<data_dir>/terminal_tabs.json`, so a relaunch can start fresh shells in the same places (FR-016). Nothing
// the shell printed or was sent, and no pid or environment, is ever written (FR-011).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::limits::{MAX_TABS_PER_SESSION, NAME_MAX_CHARS};
use super::shell::ShellKind;
use crate::store::atomic_json::{read_json_file, write_json_file};

const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedTab {
    pub id: String,
    pub name: String,
    pub cwd: String,
    /// `pwsh`, `powershell` or `cmd`; read back through `ShellKind::parse_saved`.
    pub shell: String,
    pub order: u32,
}

impl Default for SavedTab {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            cwd: String::new(),
            shell: ShellKind::Powershell.as_str().to_string(),
            order: 0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedSession {
    pub active_tab_id: Option<String>,
    pub tabs: Vec<SavedTab>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedTabs {
    pub version: u32,
    pub sessions: BTreeMap<String, SavedSession>,
}

impl Default for SavedTabs {
    fn default() -> Self {
        Self {
            version: VERSION,
            sessions: BTreeMap::new(),
        }
    }
}

pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("terminal_tabs.json")
}

/// Serialises read-modify-write cycles, so two saves never interleave and lose one another's change.
static WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A name the way `terminal.rename` would have accepted it; a blank one gets its position's default.
fn clamp_name(raw: &str, index: usize) -> String {
    let clipped: String = raw.trim().chars().take(NAME_MAX_CHARS).collect();
    let name = clipped.trim();
    if name.is_empty() {
        format!("Terminal {}", index + 1)
    } else {
        name.to_string()
    }
}

fn sanitise_session(session: SavedSession) -> Option<SavedSession> {
    let mut seen = HashSet::new();
    let mut tabs: Vec<SavedTab> = session
        .tabs
        .into_iter()
        .filter(|tab| !tab.id.is_empty() && !tab.cwd.is_empty() && seen.insert(tab.id.clone()))
        .collect();
    tabs.sort_by_key(|tab| tab.order);
    tabs.truncate(MAX_TABS_PER_SESSION);
    if tabs.is_empty() {
        return None;
    }
    for (index, tab) in tabs.iter_mut().enumerate() {
        tab.name = clamp_name(&tab.name, index);
        tab.shell = ShellKind::parse_saved(&tab.shell).as_str().to_string();
    }
    let active_tab_id = session
        .active_tab_id
        .filter(|id| tabs.iter().any(|tab| &tab.id == id));
    Some(SavedSession {
        active_tab_id,
        tabs,
    })
}

/// Makes a parsed file safe to act on: an unknown version is ignored, a tab's fields are repaired or the
/// tab dropped, and (when `known` is given) records of Sessions that no longer exist are dropped.
pub fn sanitise(file: SavedTabs, known: Option<&HashSet<String>>) -> SavedTabs {
    if file.version != VERSION {
        return SavedTabs::default();
    }
    let sessions = file
        .sessions
        .into_iter()
        .filter(|(id, _)| known.is_none_or(|ids| ids.contains(id)))
        .filter_map(|(id, session)| sanitise_session(session).map(|clean| (id, clean)))
        .collect();
    SavedTabs {
        version: VERSION,
        sessions,
    }
}

async fn read(data_dir: &Path, known: Option<&HashSet<String>>) -> std::io::Result<SavedTabs> {
    let file = read_json_file(&file_path(data_dir), SavedTabs::default).await?;
    Ok(sanitise(file, known))
}

/// The saved tabs of Sessions in `known`. An unreadable file is treated as empty: a terminal that cannot
/// remember its tabs must still open.
pub async fn load(data_dir: &Path, known: &HashSet<String>) -> SavedTabs {
    read(data_dir, Some(known)).await.unwrap_or_else(|err| {
        log::warn!("terminal: could not read the saved tab list: {err}");
        SavedTabs::default()
    })
}

/// Writes the live tabs of every Session `live` reports, leaving other Sessions' records as they were.
/// `live` runs once the write lock is held, so the last writer always saves the newest state. A Session
/// with no tabs left loses its record. Failures are logged, never returned: the shells keep working.
pub async fn save_live(data_dir: &Path, live: impl FnOnce() -> BTreeMap<String, SavedSession>) {
    let _guard = WRITE_LOCK.lock().await;
    let mut saved = match read(data_dir, None).await {
        Ok(saved) => saved,
        Err(err) => {
            log::warn!("terminal: could not read the saved tab list: {err}");
            SavedTabs::default()
        }
    };
    for (session_id, session) in live() {
        if session.tabs.is_empty() {
            saved.sessions.remove(&session_id);
        } else {
            saved.sessions.insert(session_id, session);
        }
    }
    if let Err(err) = write_json_file(&file_path(data_dir), &sanitise(saved, None)).await {
        log::warn!("terminal: could not save the tab list: {err}");
    }
}

/// Drops a Session's saved tabs (archive and delete end its shells for good, FR-014).
pub async fn forget_session(data_dir: &Path, session_id: &str) {
    let _guard = WRITE_LOCK.lock().await;
    let mut saved = match read(data_dir, None).await {
        Ok(saved) => saved,
        Err(err) => {
            log::warn!("terminal: could not read the saved tab list: {err}");
            return;
        }
    };
    if saved.sessions.remove(session_id).is_none() {
        return;
    }
    if let Err(err) = write_json_file(&file_path(data_dir), &saved).await {
        log::warn!("terminal: could not save the tab list: {err}");
    }
}

#[cfg(test)]
#[path = "persist.test.rs"]
mod tests;
