// Reading a Session's checklist file. A file we cannot understand is set aside and the Session
// starts empty; a file a newer build wrote is refused untouched so a downgrade never destroys it.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::model::{ChecklistFile, FILE_VERSION};

const KEEP_CORRUPT: usize = 3;

/// Why a load failed: a file from a newer version, or an I/O error.
#[derive(Debug)]
pub enum LoadError {
    /// The file's `version` is above the one this build reads.
    Unsupported,
    Io(io::Error),
}

fn file_name(file: &Path) -> String {
    file.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Loads a Session's file, quarantining corrupt ones and treating a missing file as empty.
pub async fn load(file: &Path) -> Result<ChecklistFile, LoadError> {
    let Some(dir) = file.parent() else {
        return Ok(ChecklistFile::empty());
    };
    let name = file_name(file);
    delete_leftover_tmp(dir, &name).await;

    let raw = match tokio::fs::read(file).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(ChecklistFile::empty()),
        Err(err) => return Err(LoadError::Io(err)),
    };

    let parsed = serde_json::from_slice::<Value>(&raw).ok();
    // Missing, non-numeric or zero `version` means it is not a file of ours: quarantine, not refuse.
    let version = parsed
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1);
    let Some(version) = version else {
        return Ok(quarantine(file, dir, &name).await);
    };
    if version > u64::from(FILE_VERSION) {
        return Err(LoadError::Unsupported);
    }
    match parsed.and_then(|v| serde_json::from_value::<ChecklistFile>(v).ok()) {
        Some(loaded) => Ok(loaded),
        None => Ok(quarantine(file, dir, &name).await),
    }
}

/// Best effort: a failed rename must not block the Session, which then works with no checklist.
async fn quarantine(file: &Path, dir: &Path, name: &str) -> ChecklistFile {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut target = file.as_os_str().to_os_string();
    target.push(format!(".corrupt-{millis}"));
    let _ = tokio::fs::rename(file, target).await;
    prune_corrupt(dir, name).await;
    ChecklistFile::empty()
}

async fn entries(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let Ok(mut read) = tokio::fs::read_dir(dir).await else {
        return found;
    };
    while let Ok(Some(entry)) = read.next_entry().await {
        found.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.path(),
        ));
    }
    found
}

/// Keeps the newest few `.corrupt-<millis>` files so repeated corruption cannot fill the disk.
async fn prune_corrupt(dir: &Path, name: &str) {
    let prefix = format!("{name}.corrupt-");
    let mut corrupt: Vec<(u128, PathBuf)> = entries(dir)
        .await
        .into_iter()
        .filter_map(|(n, path)| Some((n.strip_prefix(&prefix)?.parse().ok()?, path)))
        .collect();
    corrupt.sort_by_key(|(millis, _)| std::cmp::Reverse(*millis));
    for (_, path) in corrupt.into_iter().skip(KEEP_CORRUPT) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// A crash between the temp write and the rename leaves `<name>.<pid>.<n>.tmp` behind.
async fn delete_leftover_tmp(dir: &Path, name: &str) {
    let prefix = format!("{name}.");
    for (n, path) in entries(dir).await {
        if n.starts_with(&prefix) && n.ends_with(".tmp") {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

#[cfg(test)]
#[path = "store_load.test.rs"]
mod tests;
