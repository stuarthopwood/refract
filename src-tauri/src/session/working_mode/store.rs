// Per-Session working modes persisted in `<data_dir>/working-modes.json`, keyed by Session id.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::store::atomic_json::{read_json_file, write_json_file};

use super::WorkingMode;

type Modes = BTreeMap<String, WorkingMode>;

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn file() -> PathBuf {
    crate::data_dir().join("working-modes.json")
}

pub(super) async fn load(session_id: &str) -> Option<WorkingMode> {
    load_from(&file(), session_id).await
}

/// Away is never written, so a restart or crash always drops back to Interactive.
pub(super) async fn save(session_id: &str, mode: WorkingMode) {
    save_to(&file(), session_id, mode).await;
}

/// The path is a parameter so a test reads and writes a scratch file, not the real data dir.
async fn load_from(path: &Path, session_id: &str) -> Option<WorkingMode> {
    let _guard = STORE_LOCK.lock().await;
    let modes: Modes = read_json_file(path, Modes::new).await.unwrap_or_default();
    modes.get(session_id).copied()
}

async fn save_to(path: &Path, session_id: &str, mode: WorkingMode) {
    let _guard = STORE_LOCK.lock().await;
    let mut modes: Modes = read_json_file(path, Modes::new).await.unwrap_or_default();
    modes.insert(session_id.to_string(), mode.persistable());
    if let Err(err) = write_json_file(path, &modes).await {
        log::warn!("working_mode: could not persist: {err}");
    }
}

#[cfg(test)]
#[path = "store.test.rs"]
mod tests;
