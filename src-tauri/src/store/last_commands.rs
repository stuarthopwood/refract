// The last slash-command list OMP reported, in `<data_dir>/last-commands.json` (#1812).
// A Session whose agent has not started serves it, so `/` lists commands before any start.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "last-commands.json";

// Serialises the read-modify-write of one file: two agents can report at once.
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The saved list, or `None` when nothing usable is saved: a missing file, an unparseable file
/// (quarantined by `read_json_file`), or a list with no named command.
pub async fn load_in(dir: &Path) -> Option<Vec<Value>> {
    let _guard = STORE_LOCK.lock().await;
    let saved: Option<Vec<Value>> = read_json_file(&file_in(dir), || None)
        .await
        .unwrap_or(None);
    let mut commands = saved?;
    // The file is read from disk, so entries the menu could not render are dropped here.
    commands.retain(|c| c.get("name").and_then(Value::as_str).is_some());
    (!commands.is_empty()).then_some(commands)
}

/// Replaces the saved list. An empty list is never written: it would erase a usable one.
pub async fn save_in(dir: &Path, commands: &[Value]) {
    if commands.is_empty() {
        return;
    }
    let _guard = STORE_LOCK.lock().await;
    if let Err(err) = write_json_file(&file_in(dir), &commands).await {
        log::warn!("last_commands: could not persist the command list: {err}");
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
