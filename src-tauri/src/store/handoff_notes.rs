// Conversations whose first message is an agent's handoff note, in `<data_dir>/handoff-notes.json`
// (#1861). omp's history cannot say who wrote a message, so the label is kept beside it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "handoff-notes.json";

#[derive(Serialize, Deserialize)]
struct Entry {
    at: i64,
}

type Notes = BTreeMap<String, Entry>;

// Serialises the read-modify-write: two Sessions can hand off at once.
static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The key is the file name alone, so a moved session dir keeps its labels.
fn key_of(file: &str) -> &str {
    file.rsplit(['/', '\\']).next().unwrap_or(file)
}

async fn read_in(dir: &Path) -> Notes {
    read_json_file(&file_in(dir), Notes::new)
        .await
        .unwrap_or_default()
}

/// Marks `file` as opened by a handoff note. Entries are never pruned.
pub async fn record_in(dir: &Path, file: &str, at_ms: i64) {
    let _guard = WRITE_LOCK.lock().await;
    let mut notes = read_in(dir).await;
    notes.insert(key_of(file).to_string(), Entry { at: at_ms });
    if let Err(err) = write_json_file(&file_in(dir), &notes).await {
        log::warn!("handoff_notes: could not persist the sidecar: {err}");
    }
}

pub async fn contains_in(dir: &Path, file: &str) -> bool {
    read_in(dir).await.contains_key(key_of(file))
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
