// Spec 060 (S1-02): where `usage.db` lives and which folder of OMP session files is read.
// `usage.db` is only ever inside `crate::data_dir()`; the sessions folder is only ever read.

use std::path::PathBuf;

/// `<data_dir>/usage.db` (`REFRACT_DATA_DIR` aware through `crate::data_dir()`).
pub fn usage_db_path() -> PathBuf {
    crate::data_dir().join("usage.db")
}

/// OMP's session files: `REFRACT_OMP_SESSIONS_DIR` (absolute only) when set, else
/// `~/.omp/agent/sessions`. Never written to.
pub fn sessions_dir() -> PathBuf {
    resolve_sessions_dir(
        std::env::var("REFRACT_OMP_SESSIONS_DIR").ok(),
        dirs::home_dir(),
    )
}

/// Pure resolution, same shape as `lib.rs::resolve_data_dir_override`: an unset, blank or
/// relative override is ignored and the default under `home` is used.
pub fn resolve_sessions_dir(raw: Option<String>, home: Option<PathBuf>) -> PathBuf {
    if let Some(raw) = raw {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_absolute() {
                return path;
            }
            eprintln!(
                "refract-tauri: REFRACT_OMP_SESSIONS_DIR must be an absolute path, ignoring relative value {trimmed:?}"
            );
        }
    }
    home.unwrap_or_default()
        .join(".omp")
        .join("agent")
        .join("sessions")
}
