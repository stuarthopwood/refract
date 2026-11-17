// Caches saved-history items by path, mtime and length, so an unchanged file costs one stat.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::handoff_note::marked_first_user;
use super::saved_history::{contained_history_file, read_saved_history, SavedHistory};
use crate::omp::transcript::TranscriptItem;

const CAPACITY: usize = 4;

type Key = (PathBuf, SystemTime, u64);
type Items = Arc<Vec<Arc<TranscriptItem>>>;

/// Most recently used last.
static CACHE: Mutex<Vec<(Key, Items)>> = Mutex::new(Vec::new());

/// Returns the saved history of the Session's current Conversation file, cached when unchanged.
pub async fn load_saved_history(session_dir: Option<&str>, file: Option<&str>) -> SavedHistory {
    let Some(path) = contained_history_file(session_dir, file).await else {
        return SavedHistory::Missing;
    };
    let history = load_cached(path.clone()).await;
    label_handoff_note(&path, history).await
}

/// The cache keeps the unlabelled list; a handoff Conversation gets a labelled copy per call.
async fn label_handoff_note(path: &std::path::Path, history: SavedHistory) -> SavedHistory {
    let SavedHistory::Items(items) = &history else {
        return history;
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return history;
    };
    if !crate::store::handoff_notes::contains(name).await {
        return history;
    }
    let Some((index, marked)) = marked_first_user(items) else {
        return history;
    };
    let mut labelled = items.to_vec();
    labelled[index] = Arc::new(marked);
    SavedHistory::Items(Arc::new(labelled))
}

async fn load_cached(path: PathBuf) -> SavedHistory {
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

#[cfg(test)]
#[path = "saved_history_cache.test.rs"]
mod tests;
