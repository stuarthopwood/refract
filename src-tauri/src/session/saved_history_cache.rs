// Caches saved-history items by path, mtime and length, so an unchanged file costs one stat.
// Bounded by entry count and by the summed file length, so a few huge Conversations cannot pin memory.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::checklist_source::apply_checklist_sources;
use super::handoff_note::marked_first_user;
use super::saved_history::{contained_history_file, read_saved_history, SavedHistory};
use crate::checklist::model::SendRecord;
use crate::omp::transcript::TranscriptItem;

const CAPACITY: usize = 4;
/// The file length stands in for the parsed size, which costs a walk to measure.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

type Key = (PathBuf, SystemTime, u64);
type Items = Arc<Vec<Arc<TranscriptItem>>>;

/// Most recently used last.
static CACHE: Mutex<Vec<(Key, Items)>> = Mutex::new(Vec::new());

/// Returns the saved history of the Session's current Conversation file, cached when unchanged.
/// `records` are the Session's checklist sends, applied to a copy so the cache never holds them.
pub async fn load_saved_history(
    session_dir: Option<&str>,
    file: Option<&str>,
    records: &[SendRecord],
) -> SavedHistory {
    let Some(path) = contained_history_file(session_dir, file).await else {
        return SavedHistory::Missing;
    };
    let history = load_cached(path.clone()).await;
    label_checklist_turns(label_handoff_note(&path, history).await, records)
}

fn label_checklist_turns(history: SavedHistory, records: &[SendRecord]) -> SavedHistory {
    let SavedHistory::Items(items) = &history else {
        return history;
    };
    let changes = apply_checklist_sources(items, records);
    if changes.is_empty() {
        return history;
    }
    let mut labelled = items.to_vec();
    for (index, item) in changes {
        labelled[index] = Arc::new(item);
    }
    SavedHistory::Items(Arc::new(labelled))
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
    insert_bounded(&mut cache, key, items, CAPACITY, MAX_BYTES);
}

/// Adds `key` as most recent, then evicts the least recent entries until both bounds hold.
/// A file longer than `max_bytes` is not cached at all, so it cannot flush the rest for nothing.
fn insert_bounded(
    cache: &mut Vec<(Key, Items)>,
    key: Key,
    items: Items,
    capacity: usize,
    max_bytes: u64,
) {
    cache.retain(|(k, _)| k.0 != key.0);
    if key.2 > max_bytes {
        return;
    }
    cache.push((key, items));
    let mut total: u64 = cache.iter().map(|(k, _)| k.2).sum();
    while cache.len() > capacity || total > max_bytes {
        let (evicted, _) = cache.remove(0);
        total -= evicted.2;
    }
}

#[cfg(test)]
#[path = "saved_history_cache.test.rs"]
mod tests;
