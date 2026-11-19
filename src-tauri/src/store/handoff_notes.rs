// Conversations whose first message is an agent's handoff note, in `<data_dir>/handoff-notes.json`
// (#1861). omp's history cannot say who wrote a message, so the label is kept beside it.
// The file is read once per directory and then served from memory; every change writes through.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "handoff-notes.json";

/// The key is a bare file name, so the Session it belongs to is unknown and a missing file cannot be
/// told from one in another Session dir. The oldest labels are dropped past this cap instead.
const MAX_ENTRIES: usize = 500;

#[derive(Serialize, Deserialize)]
struct Entry {
    at: i64,
}

type Notes = BTreeMap<String, Entry>;

// The cache and the lock in one: two Sessions can hand off at once, and a load must not race a record.
static CACHE: tokio::sync::Mutex<Option<HashMap<PathBuf, Notes>>> =
    tokio::sync::Mutex::const_new(None);

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The key is the file name alone, so a moved session dir keeps its labels.
fn key_of(file: &str) -> &str {
    file.rsplit(['/', '\\']).next().unwrap_or(file)
}

/// Drops the oldest entries (by `at`, then name) until at most `max` remain.
fn prune(notes: &mut Notes, max: usize) {
    while notes.len() > max {
        let Some(oldest) = notes
            .iter()
            .min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)))
            .map(|(key, _)| key.clone())
        else {
            return;
        };
        notes.remove(&oldest);
    }
}

/// The notes of `dir`, read from disk only the first time.
async fn loaded<'a>(cache: &'a mut Option<HashMap<PathBuf, Notes>>, dir: &Path) -> &'a mut Notes {
    let by_dir = cache.get_or_insert_with(HashMap::new);
    if !by_dir.contains_key(dir) {
        let notes = read_json_file(&file_in(dir), Notes::new)
            .await
            .unwrap_or_default();
        by_dir.insert(dir.to_path_buf(), notes);
    }
    by_dir.get_mut(dir).expect("inserted above")
}

/// Marks `file` as opened by a handoff note. The oldest entries are dropped past `MAX_ENTRIES`.
pub async fn record_in(dir: &Path, file: &str, at_ms: i64) {
    let mut guard = CACHE.lock().await;
    let notes = loaded(&mut guard, dir).await;
    notes.insert(key_of(file).to_string(), Entry { at: at_ms });
    prune(notes, MAX_ENTRIES);
    if let Err(err) = write_json_file(&file_in(dir), &*notes).await {
        log::warn!("handoff_notes: could not persist the sidecar: {err}");
    }
}

pub async fn contains_in(dir: &Path, file: &str) -> bool {
    let mut guard = CACHE.lock().await;
    loaded(&mut guard, dir).await.contains_key(key_of(file))
}

pub async fn record(file: &str, at_ms: i64) {
    record_in(&dir(), file, at_ms).await;
}

pub async fn contains(file: &str) -> bool {
    contains_in(&dir(), file).await
}

#[cfg(not(test))]
fn dir() -> PathBuf {
    crate::data_dir()
}

#[cfg(test)]
thread_local! {
    static TEST_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Unit tests must not read the real data dir: a test points this thread at its own scratch dir.
#[cfg(test)]
pub(crate) fn use_dir_for_test(dir: PathBuf) {
    TEST_DIR.with(|d| *d.borrow_mut() = Some(dir));
}

#[cfg(test)]
fn dir() -> PathBuf {
    TEST_DIR
        .with(|d| d.borrow().clone())
        .unwrap_or_else(|| crate::test_scratch::path("no-handoff-notes"))
}

#[cfg(test)]
#[path = "handoff_notes.test.rs"]
mod tests;
