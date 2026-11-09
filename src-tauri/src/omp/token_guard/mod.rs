// Token guard: the `omp` overlay and rules file, applied to Refract Sessions only.

use std::io;
use std::path::Path;

pub mod args;
pub mod counter;
pub mod legacy;
pub mod migrate;
pub mod overlay;
pub mod rules;
pub mod shake;
pub mod triggers;
pub mod values;

/// Writes `bytes` atomically and skips the write when the file already matches, since Windows rename can fail on an open overlay.
pub(crate) async fn write_atomic_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Ok(existing) = tokio::fs::read(path).await {
        if existing == bytes {
            return Ok(());
        }
    }
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), unique_suffix()));
    let tmp = std::path::PathBuf::from(tmp_name);
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(err) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

fn unique_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}
