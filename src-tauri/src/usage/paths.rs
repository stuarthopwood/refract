// Spec 060 header; `usage.db` lives only under the data dir and the sessions folder is read-only.

use std::path::PathBuf;

/// `<data_dir>/usage.db`.
pub fn usage_db_path() -> PathBuf {
    crate::data_dir().join("usage.db")
}

/// Resolves OMP's session folder; `REFRACT_OMP_SESSIONS_DIR` must be absolute to take effect.
pub fn sessions_dir() -> PathBuf {
    resolve_sessions_dir(
        std::env::var("REFRACT_OMP_SESSIONS_DIR").ok(),
        dirs::home_dir(),
    )
}

/// Pure resolution; a blank or relative override falls back to the default under `home`.
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
