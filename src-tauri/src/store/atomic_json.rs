// Port of `src/main/store/atomicJson.ts`: write-tmp-then-fsync-then-rename so a crash never
// leaves a torn file, and a file that fails to parse is quarantined instead of blocking launch
// (data-model.md "Stored by Refract").
//
// `atomicJson.ts`'s own per-file write queue (`enqueueWrite`, keyed by the resolved, lowercase
// path) exists to serialise two independent writers that might otherwise race on the same
// `<name>.json.tmp` name. This port has no equivalent queue: every caller in this build
// (`registry.rs`'s `RegistryStore`, `settings.rs`'s `SettingsStore`) is reached only through its
// own `Arc<tokio::sync::Mutex<Store>>` in `ipc::AppState`, so at most one write to a given file is
// ever in flight at a time by construction -- the outer store lock already provides the
// serialisation `enqueueWrite` existed to add.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

/// Reads and parses `file`. A missing file returns `make_default()`. A file that exists but
/// fails to parse (invalid JSON, or JSON that does not match `T`'s shape -- the latter has no TS
/// equivalent, since `JSON.parse` plus a type-assertion never fails structurally the way `serde`
/// does, but the same "never let a bad file block launch" intent applies) is renamed to
/// `<name>.json.corrupt-<millis-since-epoch>` and `make_default()` is returned. A read failure
/// other than "file does not exist" (for example a permissions error) is propagated, matching
/// `atomicJson.ts`'s own `if (isEnoent(err)) return makeDefault(); throw err`.
pub async fn read_json_file<T, F>(file: &Path, make_default: F) -> io::Result<T>
where
    T: DeserializeOwned,
    F: FnOnce() -> T,
{
    let raw = match tokio::fs::read(file).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(make_default()),
        Err(err) => return Err(err),
    };

    match serde_json::from_slice::<T>(&raw) {
        Ok(value) => Ok(value),
        Err(_) => {
            quarantine(file).await;
            Ok(make_default())
        }
    }
}

/// Best effort: even if the quarantine rename fails, still falls back to a fresh default rather
/// than let a corrupt file block startup (matches the TS `try { await fs.rename(...) } catch {}`).
async fn quarantine(file: &Path) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut corrupt_name = file.as_os_str().to_os_string();
    corrupt_name.push(format!(".corrupt-{millis}"));
    let _ = tokio::fs::rename(file, corrupt_name).await;
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `value` to `file` atomically: serialise to a uniquely-named `<name>.json.<pid>.<n>.tmp`,
/// flush it to disk, then rename over `<name>.json`. `rename` on the same volume is atomic, so
/// readers never see a partially written file.
pub async fn write_json_file<T: Serialize>(file: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }

    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = file.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.{n}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp_name);

    let data = serde_json::to_vec_pretty(value).expect("refract-tauri: value must be JSON-serialisable");
    let mut handle = tokio::fs::File::create(&tmp).await?;
    handle.write_all(&data).await?;
    handle.sync_all().await?;
    drop(handle);
    tokio::fs::rename(&tmp, file).await?;
    Ok(())
}

/// Type guard so callers can narrow a caught I/O error to "file does not exist" and branch on it
/// -- the Rust equivalent of `atomicJson.ts`'s own `isEnoent`.
pub fn is_enoent(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound
}
