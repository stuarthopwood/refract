// The last slash-command list OMP reported, in `<data_dir>/last-commands.json` (#1812).
// A Session whose agent has not started serves it, so `/` lists commands before any start.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::atomic_json::{quarantine, read_json_file, write_json_file};

const FILE_NAME: &str = "last-commands.json";

// Bounds for a file read from disk: a real list is a few dozen entries, so more is damage or tampering.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 500;

// Serialises the read-modify-write of one file: two agents can report at once. Holds the last list
// written (and where), so an agent re-reporting an unchanged list costs no fsync.
static STORE: tokio::sync::Mutex<Option<(PathBuf, Vec<Value>)>> =
    tokio::sync::Mutex::const_new(None);

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The saved list, or `None` when nothing usable is saved: a missing file, an unparseable or
/// oversize file (both quarantined), or a list with no named command.
pub async fn load_in(dir: &Path) -> Option<Vec<Value>> {
    let _guard = STORE.lock().await;
    let file = file_in(dir);
    if let Ok(meta) = tokio::fs::metadata(&file).await {
        if meta.len() > MAX_FILE_BYTES {
            quarantine(&file).await;
            return None;
        }
    }
    let saved: Option<Vec<Value>> = read_json_file(&file, || None).await.unwrap_or(None);
    let mut commands = saved?;
    if commands.len() > MAX_ENTRIES {
        quarantine(&file).await;
        return None;
    }
    // The file is read from disk, so entries the menu could not render are dropped here.
    commands.retain(|c| c.get("name").and_then(Value::as_str).is_some());
    (!commands.is_empty()).then_some(commands)
}

/// Replaces the saved list. An empty list is never written: it would erase a usable one.
pub async fn save_in(dir: &Path, commands: &[Value]) {
    if commands.is_empty() {
        return;
    }
    let mut last_saved = STORE.lock().await;
    let file = file_in(dir);
    if matches!(&*last_saved, Some((path, list)) if *path == file && list == commands) {
        return;
    }
    match write_json_file(&file, &commands).await {
        Ok(()) => *last_saved = Some((file, commands.to_vec())),
        Err(err) => log::warn!("last_commands: could not persist the command list: {err}"),
    }
}

// Unit tests run agents against scratch registries, so they must not touch the real data dir.
pub async fn load() -> Option<Vec<Value>> {
    if cfg!(test) {
        return None;
    }
    load_in(&crate::data_dir()).await
}

pub async fn save(commands: &[Value]) {
    if cfg!(test) {
        return;
    }
    save_in(&crate::data_dir(), commands).await;
}

#[cfg(test)]
#[path = "last_commands.test.rs"]
mod tests;
