// Token guard: the `omp` overlay and rules file, applied to Refract Sessions only.

use std::io;
use std::path::Path;

pub mod args;
pub mod config_yaml;
pub mod counter;
pub mod legacy;
pub mod migrate;
pub mod overlay;
pub mod rules;
pub mod shake;
pub mod triggers;
pub mod values;

/// Writes `bytes` atomically and skips the write when the file already matches, since Windows rename can fail on an open overlay.
/// A symlinked `path` is written through to its real file, and the original file's permissions carry over to the replacement.
pub(crate) async fn write_atomic_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = resolve_symlink(path).await;
    let path = target.as_path();
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
    let swapped = async {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            tokio::fs::set_permissions(&tmp, meta.permissions()).await?;
        }
        tokio::fs::rename(&tmp, path).await
    }
    .await;
    if let Err(err) = swapped {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

/// Renaming over a symlink would replace the link, so the write goes to the file it points at. A dangling link keeps its own path.
async fn resolve_symlink(path: &Path) -> std::path::PathBuf {
    let is_link = tokio::fs::symlink_metadata(path)
        .await
        .is_ok_and(|meta| meta.file_type().is_symlink());
    if is_link {
        if let Ok(real) = tokio::fs::canonicalize(path).await {
            return real;
        }
    }
    path.to_path_buf()
}

fn unique_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_a_new_file_and_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.yml");
        write_atomic_if_changed(&file, b"a: 1\n").await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a: 1\n");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn a_symlinked_target_is_written_through_and_stays_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.yml");
        let link = dir.path().join("config.yml");
        std::fs::write(&real, "a: 1\n").unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&real, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&real, &link);
        if linked.is_err() {
            // Creating a symlink on Windows needs a privilege this machine may lack.
            return;
        }
        write_atomic_if_changed(&link, b"a: 2\n").await.unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "a: 2\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_replacement_keeps_the_original_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.yml");
        std::fs::write(&file, "a: 1\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic_if_changed(&file, b"a: 2\n").await.unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
