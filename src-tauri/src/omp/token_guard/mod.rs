// Token guard (issue #1212, spec 021): Refract's own OMP launch overlay and rules file. Every
// `omp` Refract launches gets `--config <overlay>` and `--append-system-prompt <rules file>`
// (`args`), so the token-cost settings win over the developer's global OMP config for Refract
// Sessions only. The values live in Refract's own store (`values`), never in the global config.

use std::io;
use std::path::Path;

pub mod args;
pub mod overlay;
pub mod rules;
pub mod values;

/// Writes `bytes` to `path` atomically (unique temp file, then rename). A file that already holds
/// exactly these bytes is left alone: on Windows a rename over a file another process (a running
/// `omp` reading the overlay) holds open can fail, and an unchanged file needs no write.
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
