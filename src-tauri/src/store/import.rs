// One-time import of the Electron build's `registry.json`/`settings.json`/`profileCache.json`
// into this build's own data directory (issue #796 acceptance item 6, lane R13a, pulled forward
// so Stuart can daily-drive the Rust build before Electron is deleted). Runs once, at startup,
// before `RegistryStore::open`/`SettingsStore::open` read `data_dir` (`lib.rs::run()`).
//
// Read-only on `source_dir` (Electron's pinned `userData`): every read uses a plain, capped
// `tokio::fs::read`/`serde_json::from_slice`, never `atomic_json::read_json_file` (which would
// quarantine -- RENAME -- a bad source file; a write to the Electron folder, never allowed). A
// source parse failure aborts with no marker, so a later launch retries.
//
// Decisions (R13a, recorded in the PR body too):
// - Registry MERGED, never overwritten, respecting the registry's own uniqueness rules
//   (`registry.rs`'s `add_repository`/`add_session`, `same_path` reused from there): a
//   same-PATH repository maps onto an existing one (Sessions' `repositoryId` rewritten to
//   match); a duplicate `id`/`worktreePath`/`(repositoryId, branch)` Session is skipped and
//   logged. The SAME checks run on a crash-recovery replay (`apply_pending`), not just a fresh
//   merge, via one shared `SessionUniqueness` tracker.
// - Settings/profile cache imported only when this build's own copy is absent (byte-for-byte,
//   `create_new`/`hard_link` semantics so a target that appears meanwhile is never clobbered).
// - All-or-nothing, no resurrection: a `PendingImportMarker` freezes WHICH ids are about to be
//   added, written BEFORE any data change. Settings/profile-cache commit first, the registry
//   last; the final marker can itself fail to write -- that returns `Failed` and keeps the
//   pending marker. A retry first checks `pending_already_landed`: since one `write_json_file`
//   call is all-or-nothing, ANY frozen id already present means the earlier registry write
//   landed in full (only the final marker failed) -- nothing is re-added then (an absent id was
//   deliberately deleted since, possibly long after that attempt; re-adding it would resurrect
//   it), only the final marker is (re)written. Only when NONE have landed does the retry
//   perform the original decision, re-validated against current uniqueness. Once the final
//   marker exists, nothing below ever runs again.
// - `ImportLock` (own file, `import_lock.rs`), once won, is held for the REST OF THIS
//   PROCESS'S LIFETIME, not just the import's own duration -- closing a deeper race where a
//   launch that merely READ a pre-merge registry snapshot could later `persist()` over a
//   completed import. A launch finding the lock held by a still-running PID skips its own
//   import (`AlreadyRunning`) and opens the stores as-is.
// - The final marker is checked BEFORE touching the lock (one stat, common path), then AGAIN
//   right after winning it (a stolen lock's former owner may already be done).
// - Same-folder guard: canonicalizes when both dirs exist, else falls back to `same_path`.

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
    /// The import lock is held by another PID that is still running; this launch does not
    /// attempt its own import and proceeds straight to opening the stores.
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

/// Returns the outcome and, if this launch won the import lock, the guard to keep alive for the
/// rest of the process (`ImportLock` decision above); `None` for every other outcome.
pub async fn import_once(
    data_dir: &Path,
    source_dir: &Path,
) -> (ImportOutcome, Option<ImportLock>) {
    if same_folder(data_dir, source_dir) {
        return (
            ImportOutcome::Failed(format!(
                "the data directory and the Electron source directory resolve to the same folder ({data_dir:?}); refusing to import"
            )),
            None,
        );
    }

    let final_marker_path = data_dir.join(FINAL_MARKER_FILE);
    if let Some(outcome) = check_final_marker(&final_marker_path).await {
        return (outcome, None);
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
                (
                    MergePlan {
                        merged: dest_registry.clone(),
                        repository_ids_added: Vec::new(),
                        session_ids_added: Vec::new(),
                    },
                    marker,
                    true,
                )
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

    // Commit order: settings and profile cache first, the registry last -- immediately followed
    // by the final marker (see the module doc comment).
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
    // The pending marker is the only record of what still needs doing; it is deleted ONLY once
    // the final marker -- which supersedes it -- is confirmed on disk.
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

/// A single `write_json_file` call is all-or-nothing, so ANY frozen id already present in
/// `dest` means the earlier write landed in full; an absent id was deliberately deleted since.
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

/// Tracks the registry's own Session uniqueness rules (`id`, `worktreePath`,
/// `(repositoryId, branch)`) across BOTH a fresh merge and a crash-recovery replay, so the two
/// paths can never drift apart on what counts as a collision. `try_claim` records the entry as
/// claimed on success, so a later entry in the same batch sees it too.
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

/// Fresh-attempt merge: respects the registry's own uniqueness rules (`registry.rs`'s
/// `add_repository`/`add_session`), not a per-id dedupe. A same-PATH repository maps onto an
/// existing Rust one (`repo_id_map` covers EVERY source repository, persisted for a retry); a
/// Session failing `SessionUniqueness::try_claim`, or referencing an unmapped repository, is
/// skipped.
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

/// Crash-recovery path, reached only when nothing from this batch has landed yet: performs the
/// original decision in full, re-validated against the registry's own uniqueness rules.
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

    let mut uniqueness = SessionUniqueness::from_registry(&merged);
    let mut session_ids_added = Vec::new();
    for id in &marker.session_ids {
        if uniqueness.ids.contains(id) {
            continue;
        }
        let Some(session) = source.sessions.iter().find(|s| &s.id == id) else {
            continue;
        };
        let mut session = session.clone();
        if let Some(mapped) = marker.repo_id_map.get(&session.repository_id) {
            session.repository_id = mapped.clone();
        }
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

/// Copies `name` from `source_dir` into `data_dir` verbatim, ONLY when `data_dir` has no copy
/// yet: a uniquely-named temp file, `sync_all` before commit, always removed afterward, and
/// create-new semantics (`hard_link`, which fails if `dest` exists, unlike `rename`) so a
/// target that appeared since the initial check is never clobbered.
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

/// Refuses outright if `data_dir` and `source_dir` resolve to the same folder: a misconfigured
/// `REFRACT_IMPORT_SOURCE_DIR` would otherwise turn "read-only source" into same-file chaos.
/// Canonicalizes (resolves symlinks/junctions) when both exist; falls back to the lexical
/// `same_path` compare `registry.rs` already uses when either does not exist yet.
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
