// Write-tmp, fsync, rename so a crash never leaves a torn file; unparseable files are quarantined.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

/// Reads and parses `file`: missing returns `make_default()`; an unparseable file is renamed to
/// `<name>.json.corrupt-<millis>` and the default returned; other read errors propagate.
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

/// Best effort: a failed quarantine rename still falls back to a default so startup is never blocked.
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

/// Writes `value` to `file` atomically: unique tmp file, flush, then rename over `<name>.json`
/// (atomic on one volume, so readers never see a partial file).
pub async fn write_json_file<T: Serialize>(file: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }

    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = file.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.{n}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp_name);

    let data =
        serde_json::to_vec_pretty(value).expect("refract-tauri: value must be JSON-serialisable");
    let mut handle = tokio::fs::File::create(&tmp).await?;
    handle.write_all(&data).await?;
    handle.sync_all().await?;
    drop(handle);
    tokio::fs::rename(&tmp, file).await?;
    Ok(())
}

/// Narrows a caught I/O error to "file does not exist".
pub fn is_enoent(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound
}
