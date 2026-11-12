// Read-only Delete-dialog summary of untracked and ignored entries (never removes anything).
// Links are never followed, matching `fs::remove_tree`.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Notify;

use crate::git::git::git_raw;

/// Well-known generated directory names, bucketed by name rather than listed by path.
const GENERATED_FOLDER_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
];

/// Caps the individual "other" entries listed before the rest fold into `more_count`.
const MAX_OTHER_FILES_LISTED: usize = 50;

/// Bounds a stalled `git status` process; it normally resolves in milliseconds.
const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFolderEntry {
    pub name: String,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverSummary {
    /// Worktree folder basename, so the dialog can name the Session.
    pub root_name: String,
    pub generated_folders: Vec<GeneratedFolderEntry>,
    pub other_files: Vec<String>,
    pub more_count: u64,
    /// True when `git status` failed or timed out, so the dialog shows "unknown", not "empty".
    pub unavailable: bool,
}

impl LeftoverSummary {
    fn empty(root_name: String) -> Self {
        Self {
            root_name,
            generated_folders: Vec::new(),
            other_files: Vec::new(),
            more_count: 0,
            unavailable: false,
        }
    }

    /// `git status` failed or timed out, so the result is unknown rather than empty.
    fn unavailable(root_name: String) -> Self {
        Self {
            root_name,
            generated_folders: Vec::new(),
            other_files: Vec::new(),
            more_count: 0,
            unavailable: true,
        }
    }
}

/// Counts real files under `dir` for one bucket, never following links.
/// Checks `cancel` between entries; an aborted count is an undercount, which is acceptable here.
fn count_files(dir: &Path, cancel: &AtomicBool) -> u64 {
    if cancel.load(Ordering::Relaxed) {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0u64;
    for entry in entries.flatten() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            count += count_files(&entry.path(), cancel);
        } else {
            count += 1;
        }
    }
    count
}

/// Builds the summary from NUL-split `git status` records, counting each bucket's files on disk.
/// Git collapses new subtrees, so reported directories are walked to find nested generated folders.
fn build_summary(worktree_path: &Path, porcelain: &str, cancel: &AtomicBool) -> LeftoverSummary {
    let root_name = worktree_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut generated: BTreeMap<String, u64> = BTreeMap::new();
    let mut other_files = Vec::new();
    let mut more_count = 0u64;

    for record in porcelain.split('\0') {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if record.len() < 3 {
            continue;
        }
        let code = &record[0..2];
        if code != "??" && code != "!!" {
            // Tracked (committed or modified) entries use every other code; never listed.
            continue;
        }
        let path = &record[3..];
        if path.is_empty() {
            continue;
        }
        let is_dir = path.ends_with('/');
        let trimmed = path.trim_end_matches('/');
        let basename = trimmed.rsplit('/').next().unwrap_or(trimmed);

        if !is_dir {
            if other_files.len() < MAX_OTHER_FILES_LISTED {
                other_files.push(trimmed.to_string());
            } else {
                more_count += 1;
            }
        } else if GENERATED_FOLDER_NAMES.contains(&basename) {
            let full = worktree_path.join(trimmed);
            let count = count_files(&full, cancel);
            *generated.entry(basename.to_string()).or_insert(0) += count;
        } else {
            let full = worktree_path.join(trimmed);
            walk_for_generated(
                &full,
                worktree_path,
                &mut generated,
                &mut other_files,
                &mut more_count,
                cancel,
            );
        }
    }

    if cancel.load(Ordering::Relaxed) {
        // A cancelled walk reports `unavailable`, never a partial summary that looks complete.
        return LeftoverSummary::unavailable(root_name);
    }
    LeftoverSummary {
        root_name,
        generated_folders: generated
            .into_iter()
            .map(|(name, file_count)| GeneratedFolderEntry { name, file_count })
            .collect(),
        other_files,
        more_count,
        unavailable: false,
    }
}

/// Finds nested generated folders under a collapsed directory; never follows links.
#[allow(clippy::too_many_arguments)]
fn walk_for_generated(
    dir: &Path,
    worktree_path: &Path,
    generated: &mut BTreeMap<String, u64>,
    other_files: &mut Vec<String>,
    more_count: &mut u64,
    cancel: &AtomicBool,
) {
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            push_other_file(worktree_path, &path, other_files, more_count);
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if GENERATED_FOLDER_NAMES.contains(&name.as_str()) {
                let count = count_files(&path, cancel);
                *generated.entry(name).or_insert(0) += count;
            } else {
                walk_for_generated(
                    &path,
                    worktree_path,
                    generated,
                    other_files,
                    more_count,
                    cancel,
                );
            }
        } else {
            push_other_file(worktree_path, &path, other_files, more_count);
        }
    }
}

fn push_other_file(
    worktree_path: &Path,
    path: &Path,
    other_files: &mut Vec<String>,
    more_count: &mut u64,
) {
    let relative = path
        .strip_prefix(worktree_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    if other_files.len() < MAX_OTHER_FILES_LISTED {
        other_files.push(relative);
    } else {
        *more_count += 1;
    }
}

/// In-flight summary walks keyed by Session id, so `cancel_and_wait` can stop them.
/// A `Vec` per Session, and `notify_one` so a wakeup racing the lookup is never lost.
type RegistryEntry = (Arc<AtomicBool>, Arc<Notify>);
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Vec<RegistryEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Deregisters exactly this walk's entry on drop (matched by `Arc::ptr_eq`) and sets its cancel flag.
/// Covers aborted futures, so a later `cancel_and_wait` never waits forever.
struct RegistryGuard {
    session_id: String,
    cancel: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Drop for RegistryGuard {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        let mut registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        if let Some(entries) = registry.get_mut(&self.session_id) {
            entries.retain(|(cancel, _)| !Arc::ptr_eq(cancel, &self.cancel));
            if entries.is_empty() {
                registry.remove(&self.session_id);
            }
        }
        self.notify.notify_one();
    }
}

/// Background walk for a Session's worktree, registered so `cancel_and_wait` can stop it.
/// Returns an empty summary when the worktree folder is missing.
pub async fn compute_leftover_summary(session_id: &str, worktree_path: &Path) -> LeftoverSummary {
    // Taken before registering, so `sessions.delete` cannot race the removal; it moves into the
    // blocking walk below, which keeps it even if this future is dropped.
    let read_guard = crate::fs::worktree_access::read_guard(session_id).await;

    // Registered before the first await so `cancel_and_wait` always sees this walk.
    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    {
        let mut registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        registry
            .entry(session_id.to_string())
            .or_default()
            .push((cancel.clone(), notify.clone()));
    }
    let _guard = RegistryGuard {
        session_id: session_id.to_string(),
        cancel: cancel.clone(),
        notify,
    };

    let root_name = worktree_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if tokio::fs::symlink_metadata(worktree_path).await.is_err() {
        return LeftoverSummary::empty(root_name);
    }

    let raw = git_raw(
        worktree_path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored",
            "--untracked-files=normal",
        ],
        Some(GIT_STATUS_TIMEOUT),
    )
    .await;

    if raw.code != 0 {
        // A failed or timed-out `git status` is `unavailable`, never an empty result.
        return LeftoverSummary::unavailable(root_name);
    }
    let path = worktree_path.to_path_buf();
    let cancel_for_count = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let _read_guard = read_guard;
        build_summary(&path, &raw.stdout, &cancel_for_count)
    })
    .await
    .unwrap_or_else(|_| LeftoverSummary::unavailable(root_name))
    // The registry guard drops on every exit path; the read lock ends with the blocking walk.
}

/// Cancels every walk for `session_id` and waits for each to deregister.
/// `notified()` is created before each re-check, so a `notify_one` is never missed.
pub async fn cancel_and_wait(session_id: &str) {
    let entries: Vec<RegistryEntry> = {
        let registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        registry.get(session_id).cloned().unwrap_or_default()
    };
    if entries.is_empty() {
        return;
    }
    // Logged only when a walk was actually cancelled.
    log::debug!(
        "leftover_summary::cancel_and_wait: cancelling {} in-flight walk(s)",
        entries.len()
    );
    for (cancel, _) in &entries {
        cancel.store(true, Ordering::Relaxed);
    }
    for (cancel, notify) in entries {
        loop {
            let notified = notify.notified();
            let still_running = {
                let registry = IN_FLIGHT
                    .lock()
                    .expect("leftover summary registry poisoned");
                registry
                    .get(session_id)
                    .is_some_and(|list| list.iter().any(|(c, _)| Arc::ptr_eq(c, &cancel)))
            };
            if !still_running {
                break;
            }
            notified.await;
        }
    }
}

/// Diagnostic: true if a summary walk is still registered for `session_id`.
/// Should always be false once `cancel_and_wait` has run.
pub fn is_walk_in_flight(session_id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .expect("leftover summary registry poisoned")
        .contains_key(session_id)
}
