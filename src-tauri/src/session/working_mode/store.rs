// Per-Session working modes persisted in `<data_dir>/working-modes.json`, keyed by Session id.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::store::atomic_json::{read_json_file, write_json_file};

use super::WorkingMode;

type Modes = BTreeMap<String, WorkingMode>;

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn file() -> PathBuf {
    crate::data_dir().join("working-modes.json")
}

pub(super) async fn load(session_id: &str) -> Option<WorkingMode> {
    let _guard = STORE_LOCK.lock().await;
    let modes: Modes = read_json_file(&file(), Modes::new)
        .await
        .unwrap_or_default();
    modes.get(session_id).copied()
}

/// Away is never written, so a restart or crash always drops back to Interactive.
pub(super) async fn save(session_id: &str, mode: WorkingMode) {
    let _guard = STORE_LOCK.lock().await;
    let path = file();
    let mut modes: Modes = read_json_file(&path, Modes::new).await.unwrap_or_default();
    modes.insert(session_id.to_string(), mode.persistable());
    if let Err(err) = write_json_file(&path, &modes).await {
        log::warn!("working_mode: could not persist: {err}");
    }
}
