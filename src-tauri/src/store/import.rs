// One-time import of the Electron build's `registry.json`/`settings.json`/`profileCache.json`
// into this build's own data directory (issue #796 acceptance item 6, pulled forward as lane
// R13a so Stuart can daily-drive the Rust build before Electron is deleted). Runs once, at
// startup, before `RegistryStore::open`/`SettingsStore::open` read `data_dir`
// (`lib.rs::run()`'s call site).
//
// Read-only on `source_dir` (Electron's own pinned `userData`, `src/main/index.ts`): every read
// uses a plain, size-capped `tokio::fs::read`/`serde_json::from_slice`, never
// `atomic_json::read_json_file` (which would quarantine -- RENAME -- a source file that fails
// to parse; a write to the Electron folder, which this import must never perform). A source
// parse failure is an unexpected error: logged, the attempt aborted, no marker, so a later
// launch retries.
//
// Decisions (R13a, recorded in the PR body too):
// - Registry: MERGED, never overwritten, respecting the registry's own uniqueness rules
//   (`registry.rs`'s own `add_repository`/`add_session`): a same-PATH Electron repository maps
//   onto an existing Rust repository instead of duplicating it (its Sessions' `repositoryId` is
//   rewritten to match); a Session with a duplicate `id`, a duplicate `worktreePath`, or a
//   duplicate `(repositoryId, branch)` pair is skipped and logged, never silently dropped.
// - Settings/profile cache: imported only when this build's own copy is absent (byte-for-byte,
//   no (de)serialisation round-trip, `create_new`/`hard_link` semantics so a target that
//   appeared meanwhile is never clobbered), otherwise the Rust copy is kept untouched.
// - All-or-nothing, no resurrection: a `PendingImportMarker` freezes WHICH ids are about to be
//   added, written BEFORE any data file changes. Settings and profile cache commit first, the
//   registry last, immediately followed by the final marker -- the narrowest possible window
//   between "the registry write landed" and "marked permanently done". A retry (pending marker
//   present, final marker absent) adds only ids from that FROZEN list still absent -- never a
//   fresh diff, which could resurrect an id the user deliberately removed in that window. Once
//   the final marker exists, nothing below ever runs again.
// - `ImportLock` (`create_new`, atomic to acquire) scopes the whole attempt: the Tauri
//   single-instance plugin's own rejection only exists once the `Builder` is assembled, AFTER
//   this import runs; the losing launch gets `AlreadyRunning`, no write of its own. A lock far
//   older than this import ever takes is a crashed attempt, not a live race, and is stolen
//   rather than blocking every future launch forever.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};
use super::registry::Registry;

const FINAL_MARKER_FILE: &str = "electron-import.json";
const PENDING_MARKER_FILE: &str = "electron-import-pending.json";
const LOCK_FILE: &str = "electron-import.lock";
const LOCK_STALE_AFTER_MILLIS: u128 = 30_000;
const MAX_IMPORT_FILE_BYTES: u64 = 16 * 1024 * 1024;

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

/// Frozen BEFORE any data file changes ("all-or-nothing, no resurrection" above). `repo_id_map`
/// covers every Electron repository id seen this attempt, so a retry rewrites a Session's
/// `repositoryId` identically without re-deriving path/id matches against an edited dest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingImportMarker {
    version: u32,
    started_at_millis: u128,
    repo_id_map: HashMap<String, String>,
    repository_ids: Vec<String>,
    session_ids: Vec<String>,
}

/// What happened; the caller (`lib.rs::run()`) passes it straight to `log_outcome` below.
#[derive(Debug)]
pub enum ImportOutcome {
    /// A marker from a previous launch already recorded a decision; nothing checked or copied.
    AlreadyDecided,
    /// Another launch currently holds the import lock; this launch proceeds straight to
    /// opening the stores as they are.
    AlreadyRunning,
    /// The Electron source directory has no `registry.json`; marked done (nothing to import,
    /// now or on a future launch -- tied to this build's first run, not to Electron's data).
    NoElectronRegistry,
    /// The registry merge ran (even if zero records were added); `settings_imported`/
    /// `profile_cache_imported` say whether those two files were copied.
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

/// Logs `outcome` at the right level; kept separate from the `lib.rs` call site to stay under
/// the 600-line file-size cap there.
pub fn log_outcome(outcome: ImportOutcome) {
    match outcome {
        ImportOutcome::AlreadyDecided => {}
        ImportOutcome::AlreadyRunning => {
            log::info!(
                "refract-tauri: data import: another launch is already importing, skipping this launch's attempt"
            );
        }
        ImportOutcome::NoElectronRegistry => {
            log::info!(
                "refract-tauri: data import: no Electron registry.json found, nothing to import"
            );
        }
        ImportOutcome::Imported {
            repositories_added,
            sessions_added,
            settings_imported,
            profile_cache_imported,
        } => {
            log::info!(
                "refract-tauri: data import: added {repositories_added} Repositories and {sessions_added} Sessions from Electron's registry.json (settings.json imported: {settings_imported}, profileCache.json imported: {profile_cache_imported})"
            );
        }
        ImportOutcome::Failed(err) => {
            log::error!(
                "refract-tauri: data import failed, starting with this build's own existing data only: {err}"
            );
        }
    }
}

pub async fn import_once(data_dir: &Path, source_dir: &Path) -> ImportOutcome {
    if same_folder(data_dir, source_dir) {
        return ImportOutcome::Failed(format!(
            "the data directory and the Electron source directory resolve to the same folder ({data_dir:?}); refusing to import"
        ));
    }

    let _lock = match ImportLock::acquire(data_dir).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };

    let final_marker_path = data_dir.join(FINAL_MARKER_FILE);
    match tokio::fs::try_exists(&final_marker_path).await {
        Ok(true) => return ImportOutcome::AlreadyDecided,
        Ok(false) => {}
        Err(err) => return ImportOutcome::Failed(format!("checking {final_marker_path:?}: {err}")),
    }

    let source_registry_file = source_dir.join("registry.json");
    let source_registry: Registry = match read_capped(&source_registry_file).await {
        Ok(None) => {
            // No Electron registry.json at all: still import settings/profile-cache if this
            // build has none of its own yet, then mark done -- there is nothing a future launch
            // could usefully retry (the import decision is tied to this build's first run).
            let settings_imported =
                match import_if_absent(data_dir, source_dir, "settings.json").await {
                    Ok(v) => v,
                    Err(err) => return ImportOutcome::Failed(err),
                };
            let profile_cache_imported =
                match import_if_absent(data_dir, source_dir, "profileCache.json").await {
                    Ok(v) => v,
                    Err(err) => return ImportOutcome::Failed(err),
                };
            write_final_marker(
                &final_marker_path,
                &ImportMarker {
                    version: 1,
                    imported_at_millis: now_millis(),
                    source_registry_found: false,
                    repositories_added: 0,
                    sessions_added: 0,
                    settings_imported,
                    profile_cache_imported,
                },
            )
            .await;
            let _ = tokio::fs::remove_file(data_dir.join(PENDING_MARKER_FILE)).await;
            return ImportOutcome::NoElectronRegistry;
        }
        Ok(Some(bytes)) => match serde_json::from_slice(&bytes) {
            Ok(registry) => registry,
            Err(err) => {
                return ImportOutcome::Failed(format!("parsing {source_registry_file:?}: {err}"))
            }
        },
        Err(err) => return ImportOutcome::Failed(err),
    };

    // Whatever is already in this build's own `registry.json` (possibly Stuart's real
    // Sessions/Repositories, or scratch ones an earlier lane's live check left behind), or an
    // empty registry on a fresh data dir. `read_json_file` already applies the normal
    // corrupt-quarantine resilience here, since this file IS owned by this build (never the
    // Electron one).
    let dest_registry_file = data_dir.join("registry.json");
    let dest_registry: Registry = match read_json_file(&dest_registry_file, || Registry {
        version: 1,
        repositories: Vec::new(),
        sessions: Vec::new(),
    })
    .await
    {
        Ok(registry) => registry,
        Err(err) => return ImportOutcome::Failed(format!("reading {dest_registry_file:?}: {err}")),
    };

    let pending_marker_path = data_dir.join(PENDING_MARKER_FILE);
    let existing_pending: Option<PendingImportMarker> =
        match tokio::fs::read(&pending_marker_path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(_) => None,
        };

    let (plan, pending_to_persist) = match existing_pending {
        Some(marker) => {
            let plan = apply_pending(&dest_registry, &source_registry, &marker);
            (plan, marker)
        }
        None => {
            let (plan, repo_id_map) = compute_merge(&dest_registry, &source_registry);
            let marker = PendingImportMarker {
                version: 1,
                started_at_millis: now_millis(),
                repo_id_map,
                repository_ids: plan.repository_ids_added.clone(),
                session_ids: plan.session_ids_added.clone(),
            };
            (plan, marker)
        }
    };

    if let Err(err) = write_json_file(&pending_marker_path, &pending_to_persist).await {
        return ImportOutcome::Failed(format!("writing {pending_marker_path:?}: {err}"));
    }

    // Commit order: settings and profile cache first, the registry last -- immediately followed
    // by the final marker -- so the only state a crash can leave un-marked-done is "the registry
    // write itself landed", the narrowest possible window (see the module doc comment).
    let settings_imported = match import_if_absent(data_dir, source_dir, "settings.json").await {
        Ok(v) => v,
        Err(err) => return ImportOutcome::Failed(err),
    };
    let profile_cache_imported =
        match import_if_absent(data_dir, source_dir, "profileCache.json").await {
            Ok(v) => v,
            Err(err) => return ImportOutcome::Failed(err),
        };
    if let Err(err) = write_json_file(&dest_registry_file, &plan.merged).await {
        return ImportOutcome::Failed(format!("writing {dest_registry_file:?}: {err}"));
    }

    write_final_marker(
        &final_marker_path,
        &ImportMarker {
            version: 1,
            imported_at_millis: now_millis(),
            source_registry_found: true,
            repositories_added: plan.repository_ids_added.len(),
            sessions_added: plan.session_ids_added.len(),
            settings_imported,
            profile_cache_imported,
        },
    )
    .await;
    let _ = tokio::fs::remove_file(&pending_marker_path).await;

    ImportOutcome::Imported {
        repositories_added: plan.repository_ids_added.len(),
        sessions_added: plan.session_ids_added.len(),
        settings_imported,
        profile_cache_imported,
    }
}

struct MergePlan {
    merged: Registry,
    repository_ids_added: Vec<String>,
    session_ids_added: Vec<String>,
}

/// Fresh-attempt merge: respects the registry's own uniqueness rules (`add_repository`/
/// `add_session` in `registry.rs`), not just a per-id dedupe. A same-PATH repository maps onto
/// an existing Rust one (`repo_id_map` covers EVERY source repository, persisted for a retry);
/// a Session with a duplicate `id`/`worktreePath`/`(repositoryId, branch)`, or an unmapped
/// repository, is skipped and logged. Tracking sets update as each entry is added, so two
/// source entries colliding with EACH OTHER are caught too.
fn compute_merge(dest: &Registry, source: &Registry) -> (MergePlan, HashMap<String, String>) {
    let mut merged = dest.clone();
    let mut repo_id_map: HashMap<String, String> = HashMap::new();
    let mut existing_repo_ids: HashSet<String> =
        merged.repositories.iter().map(|r| r.id.clone()).collect();
    let mut repository_ids_added = Vec::new();

    for repo in &source.repositories {
        if let Some(existing) = merged
            .repositories
            .iter()
            .find(|r| same_path(&r.path, &repo.path))
        {
            if existing.id != repo.id {
                log::info!(
                    "refract-tauri: data import: Electron repository {} ({}) matches an existing Rust repository by path, mapping its Sessions' repositoryId to {}",
                    repo.id, repo.path, existing.id
                );
            }
            repo_id_map.insert(repo.id.clone(), existing.id.clone());
            continue;
        }
        if existing_repo_ids.contains(&repo.id) {
            log::info!(
                "refract-tauri: data import: Repository id {} already exists in this build's registry.json, keeping the Rust entry",
                repo.id
            );
            repo_id_map.insert(repo.id.clone(), repo.id.clone());
            continue;
        }
        repo_id_map.insert(repo.id.clone(), repo.id.clone());
        existing_repo_ids.insert(repo.id.clone());
        repository_ids_added.push(repo.id.clone());
        merged.repositories.push(repo.clone());
    }

    let mut existing_session_ids: HashSet<String> =
        merged.sessions.iter().map(|s| s.id.clone()).collect();
    let mut existing_worktree_paths: Vec<String> = merged
        .sessions
        .iter()
        .map(|s| s.worktree_path.clone())
        .collect();
    let mut existing_repo_branch: HashSet<(String, String)> = merged
        .sessions
        .iter()
        .map(|s| (s.repository_id.clone(), s.branch.clone()))
        .collect();
    let mut session_ids_added = Vec::new();

    for session in &source.sessions {
        let Some(mapped_repo_id) = repo_id_map.get(&session.repository_id) else {
            log::info!(
                "refract-tauri: data import: Session id {} references repository {}, which was not imported; skipping",
                session.id, session.repository_id
            );
            continue;
        };
        if existing_session_ids.contains(&session.id) {
            log::info!(
                "refract-tauri: data import: Session id {} already exists in this build's registry.json, keeping the Rust entry",
                session.id
            );
            continue;
        }
        if existing_worktree_paths
            .iter()
            .any(|p| same_path(p, &session.worktree_path))
        {
            log::info!(
                "refract-tauri: data import: Session id {} has worktreePath {}, already used by an existing Session; skipping (the registry's own uniqueness rule)",
                session.id, session.worktree_path
            );
            continue;
        }
        let repo_branch_key = (mapped_repo_id.clone(), session.branch.clone());
        if existing_repo_branch.contains(&repo_branch_key) {
            log::info!(
                "refract-tauri: data import: Session id {} has branch {} already used in repository {}; skipping (the registry's own uniqueness rule)",
                session.id, session.branch, mapped_repo_id
            );
            continue;
        }

        let mut session = session.clone();
        session.repository_id = mapped_repo_id.clone();
        existing_session_ids.insert(session.id.clone());
        existing_worktree_paths.push(session.worktree_path.clone());
        existing_repo_branch.insert(repo_branch_key);
        session_ids_added.push(session.id.clone());
        merged.sessions.push(session);
    }

    (
        MergePlan {
            merged,
            repository_ids_added,
            session_ids_added,
        },
        repo_id_map,
    )
}

/// Crash-recovery path: the pending marker already decided WHICH ids to add, frozen before the
/// previous attempt's registry write. A fresh diff here could resurrect an id the user
/// deliberately removed in that window; only ids still absent from the CURRENT dest registry,
/// and still present in the freshly-read source, are added back.
fn apply_pending(dest: &Registry, source: &Registry, marker: &PendingImportMarker) -> MergePlan {
    let mut merged = dest.clone();
    let existing_repo_ids: HashSet<String> =
        merged.repositories.iter().map(|r| r.id.clone()).collect();
    let mut repository_ids_added = Vec::new();
    for id in &marker.repository_ids {
        if existing_repo_ids.contains(id) {
            continue;
        }
        if let Some(repo) = source.repositories.iter().find(|r| &r.id == id) {
            merged.repositories.push(repo.clone());
            repository_ids_added.push(id.clone());
        }
    }

    let existing_session_ids: HashSet<String> =
        merged.sessions.iter().map(|s| s.id.clone()).collect();
    let mut session_ids_added = Vec::new();
    for id in &marker.session_ids {
        if existing_session_ids.contains(id) {
            continue;
        }
        if let Some(session) = source.sessions.iter().find(|s| &s.id == id) {
            let mut session = session.clone();
            if let Some(mapped) = marker.repo_id_map.get(&session.repository_id) {
                session.repository_id = mapped.clone();
            }
            merged.sessions.push(session);
            session_ids_added.push(id.clone());
        }
    }

    MergePlan {
        merged,
        repository_ids_added,
        session_ids_added,
    }
}

/// Copies `name` from `source_dir` into `data_dir` verbatim, ONLY when `data_dir` has no copy
/// of its own yet: a uniquely-named temp file, `sync_all` before the commit step, the temp
/// file always removed afterward, and create-new semantics (`hard_link`, which fails if `dest`
/// exists -- unlike `rename`, which silently overwrites everywhere including Windows) so a
/// target that appeared since the initial check is never clobbered.
async fn import_if_absent(data_dir: &Path, source_dir: &Path, name: &str) -> Result<bool, String> {
    let dest = data_dir.join(name);
    if matches!(tokio::fs::try_exists(&dest).await, Ok(true)) {
        return Ok(false);
    }

    let src = source_dir.join(name);
    let Some(bytes) = read_capped(&src).await? else {
        return Ok(false);
    };

    let n = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = data_dir.join(format!("{name}.{}.{n}.import.tmp", std::process::id()));
    if let Err(err) = write_and_sync(&tmp, &bytes).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("staging {tmp:?}: {err}"));
    }

    let link_result = tokio::fs::hard_link(&tmp, &dest).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    match link_result {
        Ok(()) => Ok(true),
        // Appeared meanwhile (another launch's own import racing this one, or the user); keep
        // what is there now, not an error -- the same "never overwrite" intent as the
        // top-of-function existence check above.
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(format!("linking into {dest:?}: {err}")),
    }
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

async fn write_and_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await
}

/// Reads `path` capped at `MAX_IMPORT_FILE_BYTES` (checked via `metadata` before reading, so an
/// oversized file is never loaded): these are small config files. `Ok(None)` for a missing
/// file, same as a bare `tokio::fs::read` NotFound.
async fn read_capped(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::metadata(path).await {
        Ok(meta) if meta.len() > MAX_IMPORT_FILE_BYTES => {
            return Err(format!(
                "{path:?} is {} bytes, over the {MAX_IMPORT_FILE_BYTES}-byte import cap",
                meta.len()
            ));
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("reading {path:?}: {err}")),
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("reading {path:?}: {err}")),
    }
}

/// Closes the race the single-instance plugin doesn't cover this early (module doc comment).
/// `path`'s mere existence is the lock; dropping this guard always removes it, win or fail.
struct ImportLock {
    path: PathBuf,
}

impl ImportLock {
    async fn acquire(data_dir: &Path) -> Result<Self, ImportOutcome> {
        let path = data_dir.join(LOCK_FILE);
        if try_create_lock(&path).await {
            return Ok(Self { path });
        }

        let stale = match tokio::fs::metadata(&path).await.and_then(|m| m.modified()) {
            Ok(modified) => SystemTime::now()
                .duration_since(modified)
                .map(|age| age.as_millis() > LOCK_STALE_AFTER_MILLIS)
                .unwrap_or(false),
            Err(_) => false,
        };
        if !stale {
            return Err(ImportOutcome::AlreadyRunning);
        }
        let _ = tokio::fs::remove_file(&path).await;
        if try_create_lock(&path).await {
            Ok(Self { path })
        } else {
            Err(ImportOutcome::AlreadyRunning)
        }
    }
}

async fn try_create_lock(path: &Path) -> bool {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .is_ok()
}

impl Drop for ImportLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Case- and drive-letter-insensitive path comparison (same rule and algorithm as
/// `registry.rs`'s own `same_path`/`resolve_path_lexical`, duplicated in miniature here rather
/// than widening that file's visibility for this one extra caller).
fn same_path(a: &str, b: &str) -> bool {
    resolve_path_lexical(a).to_lowercase() == resolve_path_lexical(b).to_lowercase()
}

fn resolve_path_lexical(p: &str) -> String {
    use std::path::Component;

    let path = Path::new(p);
    let absolute: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };

    let mut collapsed = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                collapsed.pop();
            }
            Component::CurDir => {}
            other => collapsed.push(other.as_os_str()),
        }
    }
    collapsed.to_string_lossy().into_owned()
}

/// Refuses outright if `data_dir` and `source_dir` resolve to the same folder: a misconfigured
/// `REFRACT_IMPORT_SOURCE_DIR` would otherwise turn "read-only source" into same-file chaos.
fn same_folder(a: &Path, b: &Path) -> bool {
    same_path(&a.to_string_lossy(), &b.to_string_lossy())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn write_final_marker(marker_path: &Path, marker: &ImportMarker) {
    if let Err(err) = write_json_file(marker_path, marker).await {
        log::warn!("refract-tauri: data import: failed to write {marker_path:?}: {err}");
    }
}
