// `listCache.json`: the last good default open Pull requests and Issues lists (FR-181 (b)), so a
// cold start shows rows at once. Holds the wire result as the list handlers returned it; only the
// default open key is ever written (FR-181 (d)), by the callers in `ipc/list_cache.rs`.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use super::atomic_json::{is_enoent, read_json_file, write_json_file};

const FILE_NAME: &str = "listCache.json";
const VERSION: u32 = 1;
/// A section past this is dropped, not persisted; the file is read synchronously on cold start.
const MAX_SECTION_BYTES: usize = 1024 * 1024;

/// Serialises the read-modify-write of the one file, since both list handlers write it.
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

/// Bumped by `clear`; a write-behind that captured an older value fetched for a previous account.
static EPOCH: AtomicU64 = AtomicU64::new(0);

/// The cache generation to capture before a list fetch and hand to `write`.
pub fn epoch() -> u64 {
    EPOCH.load(Ordering::SeqCst)
}

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

/// The GitHub account the cached rows were fetched with; rows are never shown to another one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CacheAccount {
    pub host: String,
    pub login: String,
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
    pub account: Option<CacheAccount>,
    #[serde(default)]
    pub pull_requests: Option<Value>,
    #[serde(default)]
    pub issues: Option<Value>,
}

impl Default for ListCache {
    fn default() -> Self {
        Self {
            version: VERSION,
            account: None,
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

/// Loads the file whoever owns it. A missing or corrupt file (quarantined by `read_json_file`) or
/// another version yields the empty cache.
async fn load(dir: &Path) -> io::Result<ListCache> {
    let mut cache: ListCache = read_json_file(&dir.join(FILE_NAME), ListCache::default).await?;
    if cache.version != VERSION {
        return Ok(ListCache::default());
    }
    sanitize(&mut cache);
    Ok(cache)
}

/// Reads the cache for `current`, the active account. Rows stored for another account, a missing
/// or corrupt file, another version or a malformed section yield no rows, never an error the
/// renderer must handle.
pub async fn read(dir: &Path, current: &CacheAccount) -> io::Result<ListCache> {
    let cache = load(dir).await?;
    if cache.account.as_ref() != Some(current) {
        return Ok(ListCache::default());
    }
    Ok(cache)
}

/// Size of `value` once serialised, counted without allocating the bytes.
fn serialised_len(value: &Value) -> usize {
    struct Counter(usize);
    impl io::Write for Counter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    if serde_json::to_writer(&mut counter, value).is_err() {
        return usize::MAX;
    }
    counter.0
}

/// `fetchedAt` is a fixed-width UTC timestamp, so a string comparison orders it.
fn fetched_at(value: &Value) -> &str {
    value
        .get("fetchedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Replaces one list's cached result for `account`, keeping the other list when it belongs to the
/// same account. Skipped without touching the file when the result lacks the list shape, is past
/// `MAX_SECTION_BYTES`, was fetched before a `clear` (`epoch` is stale), or is older than the
/// stored result.
pub async fn write(
    dir: &Path,
    kind: ListKind,
    value: Value,
    account: &CacheAccount,
    epoch: u64,
) -> io::Result<()> {
    if !has_list_shape(kind, &value) || serialised_len(&value) > MAX_SECTION_BYTES {
        return Ok(());
    }
    let _guard = WRITE_LOCK.lock().await;
    if EPOCH.load(Ordering::SeqCst) != epoch {
        return Ok(());
    }
    let mut cache = load(dir).await?;
    if cache.account.as_ref() != Some(account) {
        cache = ListCache {
            account: Some(account.clone()),
            ..ListCache::default()
        };
    }
    let section = cache.section_mut(kind);
    if section
        .as_ref()
        .is_some_and(|stored| fetched_at(stored) > fetched_at(&value))
    {
        return Ok(());
    }
    *section = Some(value);
    write_json_file(&dir.join(FILE_NAME), &cache).await
}

/// True for the cache file's leftovers: a quarantined corrupt copy or a crashed write's tmp file.
fn is_side_file(name: &str) -> bool {
    name.starts_with("listCache.json.corrupt-")
        || (name.starts_with("listCache.json.") && name.ends_with(".tmp"))
}

/// Deletes the cache file and its leftovers, so a switched or signed-out account leaves no list
/// rows behind, and invalidates every write already in flight. A missing file is fine.
pub async fn clear(dir: &Path) -> io::Result<()> {
    let _guard = WRITE_LOCK.lock().await;
    EPOCH.fetch_add(1, Ordering::SeqCst);
    match tokio::fs::remove_file(dir.join(FILE_NAME)).await {
        Err(err) if !is_enoent(&err) => return Err(err),
        _ => {}
    }
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if is_enoent(&err) => return Ok(()),
        Err(err) => return Err(err),
    };
    while let Some(entry) = entries.next_entry().await? {
        let is_file = entry.file_type().await.is_ok_and(|kind| kind.is_file());
        let named = entry.file_name();
        if is_file && named.to_str().is_some_and(is_side_file) {
            match tokio::fs::remove_file(entry.path()).await {
                Err(err) if !is_enoent(&err) => return Err(err),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "list_cache_tests.rs"]
mod tests;
