// One-time import of the Electron build's `registry.json`/`settings.json`/`profileCache.json`
// into this build's own data directory (issue #796 acceptance item 6, pulled forward as lane
// R13a so Stuart can daily-drive the Rust build before Electron is deleted). Runs once, at
// startup, before `RegistryStore::open`/`SettingsStore::open` read `data_dir`
// (`lib.rs::run()`'s call site).
//
// Read-only on `source_dir` (Electron's own pinned `userData`, `src/main/index.ts`): every read
// here uses a plain `tokio::fs::read`, never `atomic_json::read_json_file` (which would
// quarantine -- i.e. RENAME -- a source file that fails to parse; that is a write to the
// Electron folder, which this import must never perform). A source file that exists but fails
// to parse is instead treated as an unexpected error: logged, the whole attempt aborted, nothing
// written, no marker, so a later launch retries.
//
// Decisions (R13a, recorded in the PR body too):
// - Registry: MERGED, never overwritten. Stuart's real `%APPDATA%\refract-tauri\registry.json`
//   already holds scratch Sessions/Repositories written by earlier lanes' own live checks before
//   this import existed -- "import only into an empty Rust dir" would silently skip his real
//   import. Instead: every Electron Repository/Session whose `id` is not already present in the
//   Rust registry is added; an `id` that already exists in the Rust registry is left exactly as
//   it is there (the Rust entry wins on a clash) and the clash is logged, never overwritten or
//   removed. This merge is additive and idempotent: re-running it against an already-merged
//   file (for example after a failed later step forces a retry next launch) adds nothing new.
// - Settings/profile cache: imported only when this build's own copy is absent, otherwise the
//   Rust copy is kept untouched -- unlike the registry there is no per-record merge key, so
//   "keep what's already here" is the only safe rule once any Rust-side copy might exist.
// - Marker: a dedicated file (`electron-import.json`) in `data_dir` records that an import was
//   attempted, instead of inferring "already done" from the registry/settings files' mere
//   presence (which, now that the registry is merged rather than skip-on-existing-data, would
//   always look "already done" the moment any Rust Session exists). Written only after every
//   step below completes with no unexpected I/O error; an error leaves it unwritten so the next
//   launch retries (safe: every step is idempotent, so a partially-completed retry adds nothing
//   a previous attempt already added).

use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};
use super::registry::Registry;

const MARKER_FILE: &str = "electron-import.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMarker {
    version: u32,
    imported_at_millis: u128,
    source_registry_found: bool,
    repositories_added: usize,
    sessions_added: usize,
    settings_imported: bool,
    profile_cache_imported: bool,
}

/// What happened; the caller (`lib.rs::run()`) only logs it -- every branch leaves `data_dir`
/// safe for `RegistryStore::open`/`SettingsStore::open` to read normally afterward.
#[derive(Debug)]
pub enum ImportOutcome {
    /// A marker from a previous launch already recorded a decision; nothing checked or copied.
    AlreadyDecided,
    /// The Electron source directory has no `registry.json`; marked done (there was nothing to
    /// import, now or on a future launch -- the import decision is tied to this build's first
    /// run, not to whenever Electron happens to gain data).
    NoElectronRegistry,
    /// The registry merge ran (even if it added zero records -- every Electron id already
    /// existed on the Rust side); `settings_imported`/`profile_cache_imported` say whether those
    /// two files were copied (only happens when this build had no copy of its own yet).
    Imported {
        repositories_added: usize,
        sessions_added: usize,
        settings_imported: bool,
        profile_cache_imported: bool,
    },
    /// An unexpected I/O error. No marker was written, so the next launch retries; every step
    /// that already ran is safe to repeat (see the module doc comment).
    Failed(String),
}

pub async fn import_once(data_dir: &Path, source_dir: &Path) -> ImportOutcome {
    let marker_path = data_dir.join(MARKER_FILE);
    if matches!(tokio::fs::try_exists(&marker_path).await, Ok(true)) {
        return ImportOutcome::AlreadyDecided;
    }

    let source_registry_file = source_dir.join("registry.json");
    let source_registry_bytes = match tokio::fs::read(&source_registry_file).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            write_marker(
                &marker_path,
                &ImportMarker {
                    version: 1,
                    imported_at_millis: now_millis(),
                    source_registry_found: false,
                    repositories_added: 0,
                    sessions_added: 0,
                    settings_imported: false,
                    profile_cache_imported: false,
                },
            )
            .await;
            return ImportOutcome::NoElectronRegistry;
        }
        Err(err) => {
            return ImportOutcome::Failed(format!("reading {source_registry_file:?}: {err}"))
        }
    };
    let source_registry: Registry = match serde_json::from_slice(&source_registry_bytes) {
        Ok(registry) => registry,
        Err(err) => {
            return ImportOutcome::Failed(format!("parsing {source_registry_file:?}: {err}"))
        }
    };

    // Whatever is already in this build's own `registry.json` (possibly Stuart's real
    // Sessions/Repositories, or scratch ones an earlier lane's live check left behind), or an
    // empty registry on a fresh data dir. `read_json_file` already applies the normal
    // corrupt-quarantine resilience here, since this file IS owned by this build (never the
    // Electron one).
    let dest_registry_file = data_dir.join("registry.json");
    let mut dest_registry: Registry = match read_json_file(&dest_registry_file, || Registry {
        version: 1,
        repositories: Vec::new(),
        sessions: Vec::new(),
    })
    .await
    {
        Ok(registry) => registry,
        Err(err) => return ImportOutcome::Failed(format!("reading {dest_registry_file:?}: {err}")),
    };

    let existing_repo_ids: HashSet<String> = dest_registry
        .repositories
        .iter()
        .map(|r| r.id.clone())
        .collect();
    let existing_session_ids: HashSet<String> = dest_registry
        .sessions
        .iter()
        .map(|s| s.id.clone())
        .collect();

    let mut repositories_added = 0usize;
    for repo in source_registry.repositories {
        if existing_repo_ids.contains(&repo.id) {
            log::info!(
                "refract-tauri: data import: Repository id {} already exists in this build's registry.json, keeping the Rust entry",
                repo.id
            );
            continue;
        }
        dest_registry.repositories.push(repo);
        repositories_added += 1;
    }

    let mut sessions_added = 0usize;
    for session in source_registry.sessions {
        if existing_session_ids.contains(&session.id) {
            log::info!(
                "refract-tauri: data import: Session id {} already exists in this build's registry.json, keeping the Rust entry",
                session.id
            );
            continue;
        }
        dest_registry.sessions.push(session);
        sessions_added += 1;
    }

    dest_registry.version = 1;
    if let Err(err) = write_json_file(&dest_registry_file, &dest_registry).await {
        return ImportOutcome::Failed(format!("writing {dest_registry_file:?}: {err}"));
    }

    let settings_imported = match import_if_absent(data_dir, source_dir, "settings.json").await {
        Ok(imported) => imported,
        Err(err) => return ImportOutcome::Failed(err),
    };
    let profile_cache_imported =
        match import_if_absent(data_dir, source_dir, "profileCache.json").await {
            Ok(imported) => imported,
            Err(err) => return ImportOutcome::Failed(err),
        };

    write_marker(
        &marker_path,
        &ImportMarker {
            version: 1,
            imported_at_millis: now_millis(),
            source_registry_found: true,
            repositories_added,
            sessions_added,
            settings_imported,
            profile_cache_imported,
        },
    )
    .await;

    ImportOutcome::Imported {
        repositories_added,
        sessions_added,
        settings_imported,
        profile_cache_imported,
    }
}

/// Copies `name` from `source_dir` into `data_dir` verbatim (byte-for-byte, no
/// (de)serialisation round-trip) ONLY when `data_dir` does not already have its own copy --
/// unlike the registry above, Settings/ProfileCache have no per-record merge key, so "keep
/// what's already here" is the only safe rule once any Rust-side copy might exist. Written
/// atomically (temp file, then rename), the same write-tmp-then-rename discipline
/// `atomic_json.rs` uses. Returns whether a copy happened.
async fn import_if_absent(data_dir: &Path, source_dir: &Path, name: &str) -> Result<bool, String> {
    let dest = data_dir.join(name);
    match tokio::fs::try_exists(&dest).await {
        Ok(true) => return Ok(false),
        Ok(false) => {}
        Err(err) => return Err(format!("checking {dest:?}: {err}")),
    }

    let src = source_dir.join(name);
    let bytes = match tokio::fs::read(&src).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("reading {src:?}: {err}")),
    };

    let tmp = data_dir.join(format!("{name}.import.tmp"));
    if let Err(err) = tokio::fs::write(&tmp, &bytes).await {
        return Err(format!("staging {tmp:?}: {err}"));
    }
    if let Err(err) = tokio::fs::rename(&tmp, &dest).await {
        return Err(format!("renaming into {dest:?}: {err}"));
    }
    Ok(true)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn write_marker(marker_path: &Path, marker: &ImportMarker) {
    if let Err(err) = write_json_file(marker_path, marker).await {
        log::warn!("refract-tauri: data import: failed to write {marker_path:?}: {err}");
    }
}
