// Issue #1205 (FR-103): a small cache of a stopped Session's saved-history transcript items,
// keyed by the contained file's path, modified time, and length, so reopening an unchanged
// file costs one stat instead of a re-parse.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::saved_history::{contained_history_file, read_saved_history, SavedHistory};
use crate::omp::transcript::TranscriptItem;

const CAPACITY: usize = 4;

type Key = (PathBuf, SystemTime, u64);
type Items = Arc<Vec<Arc<TranscriptItem>>>;

/// Most recently used last.
static CACHE: Mutex<Vec<(Key, Items)>> = Mutex::new(Vec::new());

/// Resolves the Session's current Conversation file inside its `session_dir` and returns its
/// saved history, from the cache when the file is unchanged.
pub async fn load_saved_history(session_dir: Option<&str>, file: Option<&str>) -> SavedHistory {
    let Some(path) = contained_history_file(session_dir, file).await else {
        return SavedHistory::Missing;
    };
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return SavedHistory::Missing;
    };
    let key = meta
        .modified()
        .ok()
        .map(|at| (path.clone(), at, meta.len()));
    if let Some(items) = key.as_ref().and_then(lookup) {
        return SavedHistory::Items(items);
    }
    let history = read_saved_history(path, meta.len()).await;
    if let (Some(key), SavedHistory::Items(items)) = (key, &history) {
        store(key, items.clone());
    }
    history
}

fn lookup(key: &Key) -> Option<Items> {
    let mut cache = CACHE.lock().ok()?;
    let at = cache.iter().position(|(k, _)| k == key)?;
    let entry = cache.remove(at);
    let items = entry.1.clone();
    cache.push(entry);
    Some(items)
}

fn store(key: Key, items: Items) {
    let Ok(mut cache) = CACHE.lock() else {
        return;
    };
    cache.retain(|(k, _)| k.0 != key.0);
    cache.push((key, items));
    if cache.len() > CAPACITY {
        cache.remove(0);
    }
}
