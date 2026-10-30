// One-time import of the Electron build's data into this build's data dir (#796).
// Read-only on `source_dir`; a parse failure aborts with no marker.

mod import_lock;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};
use super::registry::{same_path, Registry};
use import_lock::ImportLock;

const FINAL_MARKER_FILE: &str = "electron-import.json";
const PENDING_MARKER_FILE: &str = "electron-import-pending.json";
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

/// Frozen before any data file changes; `repo_id_map` lets a retry rewrite `repositoryId`s
/// identically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingImportMarker {
    version: u32,
    started_at_millis: u128,
    repo_id_map: HashMap<String, String>,
    repository_ids: Vec<String>,
    session_ids: Vec<String>,
}

/// What happened; passed straight to `log_outcome`.
#[derive(Debug)]
pub enum ImportOutcome {
    /// A previous launch already recorded a decision; nothing copied.
    AlreadyDecided,
    /// The lock is held by another running PID; this launch skips its own import.
    AlreadyRunning,
    /// The Electron source has no `registry.json`; marked done.
    NoElectronRegistry,
    /// The registry merge ran; the flags say whether settings/profile cache were copied.
    Imported {
        repositories_added: usize,
        sessions_added: usize,
        settings_imported: bool,
        profile_cache_imported: bool,
    },
    /// An unexpected I/O error. No marker was written, so the next launch retries safely.
    Failed(String),
}

/// Logs `outcome` at the right level.
pub fn log_outcome(outcome: &ImportOutcome) {
    match outcome {
        ImportOutcome::AlreadyDecided => {}
        ImportOutcome::AlreadyRunning => {
            log::info!(
                "refract-tauri: data import: another running launch owns the import lock, skipping this launch's attempt"
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

/// Returns the outcome and, if this launch won the import lock, the guard to keep for the rest
/// of the process.
pub async fn import_once(
    data_dir: &Path,
    source_dir: &Path,
) -> (ImportOutcome, Option<ImportLock>) {
    let final_marker_path = data_dir.join(FINAL_MARKER_FILE);
    if let Some(outcome) = check_final_marker(&final_marker_path).await {
        return (outcome, None);
    }

    if same_folder(data_dir, source_dir) {
        return (
            ImportOutcome::Failed(format!(
                "the data directory and the Electron source directory resolve to the same folder ({data_dir:?}); refusing to import"
            )),
            None,
        );
    }

    let lock = match ImportLock::acquire(data_dir).await {
        Ok(lock) => lock,
        Err(outcome) => return (outcome, None),
    };

    // A lock stolen from a dead former owner may already have a completed import behind it.
    if let Some(outcome) = check_final_marker(&final_marker_path).await {
        return (outcome, Some(lock));
    }

    let outcome = run_import(data_dir, source_dir, &final_marker_path).await;
    (outcome, Some(lock))
}

async fn run_import(data_dir: &Path, source_dir: &Path, final_marker_path: &Path) -> ImportOutcome {
    let source_registry_file = source_dir.join("registry.json");
    let source_registry: Registry = match read_capped(&source_registry_file).await {
        Ok(None) => {
            // No Electron registry.json: still import settings/profile-cache, then mark done.
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
            let marker = ImportMarker {
                version: 1,
                imported_at_millis: now_millis(),
                source_registry_found: false,
                repositories_added: 0,
                sessions_added: 0,
                settings_imported,
                profile_cache_imported,
            };
            if let Err(err) = write_final_marker(final_marker_path, &marker).await {
                return ImportOutcome::Failed(format!("writing {final_marker_path:?}: {err}"));
            }
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

    // This build's own registry (possibly real data); `read_json_file`'s quarantine is fine here
    // since this file is not Electron's.
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
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(marker) => Some(marker),
                Err(err) => {
                    return ImportOutcome::Failed(format!("parsing {pending_marker_path:?}: {err}"))
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return ImportOutcome::Failed(format!("reading {pending_marker_path:?}: {err}"))
            }
        };

    let (plan, pending_to_persist, registry_already_committed) = match existing_pending {
        Some(marker) => {
            if pending_already_landed(&dest_registry, &marker) {
                let plan = MergePlan {
                    merged: dest_registry.clone(),
                    repository_ids_added: marker.repository_ids.clone(),
                    session_ids_added: marker.session_ids.clone(),
                };
                (plan, marker, true)
            } else {
                let plan = apply_pending(&dest_registry, &source_registry, &marker);
                (plan, marker, false)
            }
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
            (plan, marker, false)
        }
    };

    if !registry_already_committed {
        if let Err(err) = write_json_file(&pending_marker_path, &pending_to_persist).await {
            return ImportOutcome::Failed(format!("writing {pending_marker_path:?}: {err}"));
        }
    }

    // Commit order: settings and profile cache, then the registry, then the final marker.
    let settings_imported = match import_if_absent(data_dir, source_dir, "settings.json").await {
        Ok(v) => v,
        Err(err) => return ImportOutcome::Failed(err),
    };
    let profile_cache_imported =
        match import_if_absent(data_dir, source_dir, "profileCache.json").await {
            Ok(v) => v,
            Err(err) => return ImportOutcome::Failed(err),
        };
    if !registry_already_committed {
        if let Err(err) = write_json_file(&dest_registry_file, &plan.merged).await {
            return ImportOutcome::Failed(format!("writing {dest_registry_file:?}: {err}"));
        }
    }

    let marker = ImportMarker {
        version: 1,
        imported_at_millis: now_millis(),
        source_registry_found: true,
        repositories_added: plan.repository_ids_added.len(),
        sessions_added: plan.session_ids_added.len(),
        settings_imported,
        profile_cache_imported,
    };
    // The pending marker is deleted only once the final marker is confirmed on disk.
    if let Err(err) = write_final_marker(final_marker_path, &marker).await {
        return ImportOutcome::Failed(format!("writing {final_marker_path:?}: {err}"));
    }
    let _ = tokio::fs::remove_file(&pending_marker_path).await;

    ImportOutcome::Imported {
        repositories_added: plan.repository_ids_added.len(),
        sessions_added: plan.session_ids_added.len(),
        settings_imported,
        profile_cache_imported,
    }
}

async fn check_final_marker(final_marker_path: &Path) -> Option<ImportOutcome> {
    match tokio::fs::try_exists(final_marker_path).await {
        Ok(true) => Some(ImportOutcome::AlreadyDecided),
        Ok(false) => None,
        Err(err) => Some(ImportOutcome::Failed(format!(
            "checking {final_marker_path:?}: {err}"
        ))),
    }
}

/// One `write_json_file` is atomic: any frozen id present means the write landed.
fn pending_already_landed(dest: &Registry, marker: &PendingImportMarker) -> bool {
    let repo_ids: HashSet<&str> = dest.repositories.iter().map(|r| r.id.as_str()).collect();
    let session_ids: HashSet<&str> = dest.sessions.iter().map(|s| s.id.as_str()).collect();
    marker
        .repository_ids
        .iter()
        .any(|id| repo_ids.contains(id.as_str()))
        || marker
            .session_ids
            .iter()
            .any(|id| session_ids.contains(id.as_str()))
}

struct MergePlan {
    merged: Registry,
    repository_ids_added: Vec<String>,
    session_ids_added: Vec<String>,
}

/// Applies the registry's Session uniqueness rules for both fresh merge and replay, so the two
/// cannot drift. `try_claim` records the entry on success.
struct SessionUniqueness {
    ids: HashSet<String>,
    worktree_paths: Vec<String>,
    repo_branch: HashSet<(String, String)>,
}

impl SessionUniqueness {
    fn from_registry(registry: &Registry) -> Self {
        Self {
            ids: registry.sessions.iter().map(|s| s.id.clone()).collect(),
            worktree_paths: registry
                .sessions
                .iter()
                .map(|s| s.worktree_path.clone())
                .collect(),
            repo_branch: registry
                .sessions
                .iter()
                .map(|s| (s.repository_id.clone(), s.branch.clone()))
                .collect(),
        }
    }

    fn try_claim(&mut self, session: &super::registry::Session) -> bool {
        if self.ids.contains(&session.id) {
            log::info!(
                "refract-tauri: data import: Session id {} already exists, keeping the Rust entry",
                session.id
            );
            return false;
        }
        if self
            .worktree_paths
            .iter()
            .any(|p| same_path(p, &session.worktree_path))
        {
            log::info!("refract-tauri: data import: Session id {} worktreePath collides with an existing Session; skipping", session.id);
            return false;
        }
        let key = (session.repository_id.clone(), session.branch.clone());
        if self.repo_branch.contains(&key) {
            log::info!("refract-tauri: data import: Session id {} branch {} collides in repository {}; skipping", session.id, session.branch, session.repository_id);
            return false;
        }
        self.ids.insert(session.id.clone());
        self.worktree_paths.push(session.worktree_path.clone());
        self.repo_branch.insert(key);
        true
    }
}

/// Fresh-attempt merge: a same-path repository maps onto an existing one (`repo_id_map`, persisted
/// for retry); a Session failing `try_claim` or with an unmapped repository is skipped.
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
                log::info!("refract-tauri: data import: Electron repository {} matches an existing one by path, mapping its Sessions' repositoryId to {}", repo.id, existing.id);
            }
            repo_id_map.insert(repo.id.clone(), existing.id.clone());
            continue;
        }
        if existing_repo_ids.contains(&repo.id) {
            log::info!("refract-tauri: data import: Repository id {} already exists, keeping the Rust entry", repo.id);
            repo_id_map.insert(repo.id.clone(), repo.id.clone());
            continue;
        }
        repo_id_map.insert(repo.id.clone(), repo.id.clone());
        existing_repo_ids.insert(repo.id.clone());
        repository_ids_added.push(repo.id.clone());
        merged.repositories.push(repo.clone());
    }

    let mut uniqueness = SessionUniqueness::from_registry(&merged);
    let mut session_ids_added = Vec::new();

    for session in &source.sessions {
        let Some(mapped_repo_id) = repo_id_map.get(&session.repository_id) else {
            log::info!("refract-tauri: data import: Session id {} references an unimported repository; skipping", session.id);
            continue;
        };
        let mut session = session.clone();
        session.repository_id = mapped_repo_id.clone();
        if !uniqueness.try_claim(&session) {
            continue;
        }
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

/// Crash-recovery path when nothing from this batch landed: redoes the decision, re-validated
/// since `dest` may have changed after the pending marker was frozen.
fn apply_pending(dest: &Registry, source: &Registry, marker: &PendingImportMarker) -> MergePlan {
    let mut merged = dest.clone();
    let mut repo_id_map = marker.repo_id_map.clone();
    let mut repository_ids_added = Vec::new();
    for id in &marker.repository_ids {
        if merged.repositories.iter().any(|r| &r.id == id) {
            continue;
        }
        let Some(repo) = source.repositories.iter().find(|r| &r.id == id) else {
            continue;
        };
        if let Some(existing) = merged
            .repositories
            .iter()
            .find(|r| same_path(&r.path, &repo.path))
        {
            repo_id_map.insert(repo.id.clone(), existing.id.clone());
            continue;
        }
        merged.repositories.push(repo.clone());
        repository_ids_added.push(id.clone());
    }

    let mut uniqueness = SessionUniqueness::from_registry(&merged);
    let mut session_ids_added = Vec::new();
    for id in &marker.session_ids {
        if uniqueness.ids.contains(id) {
            continue;
        }
        let Some(session) = source.sessions.iter().find(|s| &s.id == id) else {
            continue;
        };
        let Some(mapped_repo_id) = repo_id_map.get(&session.repository_id) else {
            continue;
        };
        if !merged.repositories.iter().any(|r| &r.id == mapped_repo_id) {
            // Dangling repositoryId: never add a Session pointing nowhere.
            continue;
        }
        let mut session = session.clone();
        session.repository_id = mapped_repo_id.clone();
        if !uniqueness.try_claim(&session) {
            continue;
        }
        session_ids_added.push(id.clone());
        merged.sessions.push(session);
    }

    MergePlan {
        merged,
        repository_ids_added,
        session_ids_added,
    }
}

/// Copies `name` into `data_dir` only when absent; `hard_link` (fails if `dest` exists) so a
/// target that appeared meanwhile is never clobbered.
async fn import_if_absent(data_dir: &Path, source_dir: &Path, name: &str) -> Result<bool, String> {
    let dest = data_dir.join(name);
    match tokio::fs::try_exists(&dest).await {
        Ok(true) => return Ok(false),
        Ok(false) => {}
        Err(err) => return Err(format!("checking {dest:?}: {err}")),
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
        // Appeared meanwhile (another launch or the user); keep it, not an error.
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

/// Reads `path` capped at `MAX_IMPORT_FILE_BYTES` (size checked first, so an oversized file is
/// never loaded). `Ok(None)` for a missing file.
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

/// Refuses if `data_dir`/`source_dir` are the same folder: canonicalizes when both exist, else
/// compares lexically via `same_path`.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => same_path(&a.to_string_lossy(), &b.to_string_lossy()),
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn write_final_marker(marker_path: &Path, marker: &ImportMarker) -> std::io::Result<()> {
    write_json_file(marker_path, marker).await
}
