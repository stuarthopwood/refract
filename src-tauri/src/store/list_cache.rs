// `listCache.json`: the last good default open Pull requests and Issues lists (FR-181 (b)), so a
// cold start shows rows at once. Holds the wire result as the list handlers returned it; only the
// default open key is ever written (FR-181 (d)), by the callers in `ipc/list_cache.rs`.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use super::atomic_json::{is_enoent, read_json_file, write_json_file};

const FILE_NAME: &str = "listCache.json";
const VERSION: u32 = 1;
/// A list is at most 200 Projects of 50 rows; a result past this is dropped, not persisted.
const MAX_SECTION_BYTES: usize = 4 * 1024 * 1024;

/// Serialises the read-modify-write of the one file, since both list handlers write it.
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    PullRequests,
    Issues,
}

impl ListKind {
    /// The field that holds the rows in this list's wire result.
    fn rows_field(self) -> &'static str {
        match self {
            Self::PullRequests => "items",
            Self::Issues => "issues",
        }
    }
}

fn current_version() -> u32 {
    VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListCache {
    #[serde(default = "current_version")]
    pub version: u32,
    #[serde(default)]
    pub pull_requests: Option<Value>,
    #[serde(default)]
    pub issues: Option<Value>,
}

impl Default for ListCache {
    fn default() -> Self {
        Self {
            version: VERSION,
            pull_requests: None,
            issues: None,
        }
    }
}

impl ListCache {
    fn section_mut(&mut self, kind: ListKind) -> &mut Option<Value> {
        match kind {
            ListKind::PullRequests => &mut self.pull_requests,
            ListKind::Issues => &mut self.issues,
        }
    }
}

/// True when `value` has the wire shape the renderer reads: the rows array, a `skipped` array and
/// a `fetchedAt` string. A hand-edited or half-written file never reaches the renderer.
fn has_list_shape(kind: ListKind, value: &Value) -> bool {
    value.get(kind.rows_field()).is_some_and(Value::is_array)
        && value.get("skipped").is_some_and(Value::is_array)
        && value.get("fetchedAt").is_some_and(Value::is_string)
}

fn sanitize(cache: &mut ListCache) {
    for kind in [ListKind::PullRequests, ListKind::Issues] {
        let section = cache.section_mut(kind);
        if section
            .as_ref()
            .is_some_and(|value| !has_list_shape(kind, value))
        {
            *section = None;
        }
    }
}

/// Reads the cache. A missing or corrupt file (quarantined by `read_json_file`), another version
/// or a malformed section yields no rows, never an error the renderer must handle.
pub async fn read(dir: &Path) -> io::Result<ListCache> {
    let mut cache: ListCache = read_json_file(&dir.join(FILE_NAME), ListCache::default).await?;
    if cache.version != VERSION {
        return Ok(ListCache::default());
    }
    sanitize(&mut cache);
    Ok(cache)
}

/// Replaces one list's cached result, keeping the other. A result that lacks the list shape or is
/// past `MAX_SECTION_BYTES` is dropped without touching the file.
pub async fn write(dir: &Path, kind: ListKind, value: Value) -> io::Result<()> {
    if !has_list_shape(kind, &value) || value.to_string().len() > MAX_SECTION_BYTES {
        return Ok(());
    }
    let _guard = WRITE_LOCK.lock().await;
    let mut cache = read(dir).await?;
    *cache.section_mut(kind) = Some(value);
    write_json_file(&dir.join(FILE_NAME), &cache).await
}

/// Deletes the cache file, so a signed-out account leaves no list rows behind. A missing file is
/// fine.
pub async fn clear(dir: &Path) -> io::Result<()> {
    let _guard = WRITE_LOCK.lock().await;
    match tokio::fs::remove_file(dir.join(FILE_NAME)).await {
        Err(err) if !is_enoent(&err) => Err(err),
        _ => Ok(()),
    }
}

#[cfg(test)]
#[path = "list_cache_tests.rs"]
mod tests;
