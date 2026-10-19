// Issue #891, Stuart's 2026-10-19 grill item 3 (gate round 1 rewrite, issuecomment-6273798707
// item 3): "a background walk when the Delete dialog opens" listing generated folders (for
// example `node_modules`) by name with file counts, and other files by path, capped with "and N
// more". Read-only and purely informational -- Delete stays enabled throughout (the walk never
// blocks it), and this module never removes anything; that is `fs::remove_tree`'s job.
//
// Gate round 1 rewrite: the list is now built from `git status --porcelain=v1 -z --ignored
// --untracked-files=normal` instead of a raw `std::fs::read_dir` walk of the whole worktree.
// "Lists only untracked and ignored files (from git), with generated folders grouped by name;
// tracked files are not listed." Filtered to exactly the `??` (untracked) and `!!` (ignored)
// status codes -- any other code (a tracked file, modified or not) is simply never emitted by
// this command in the first place for an entry with neither code, so no separate filter is
// needed to keep tracked content out. `--untracked-files=normal` (never `=all`) is what keeps an
// entirely untracked OR ignored directory collapsed to ONE line rather than expanded into every
// file beneath it -- the mechanism that lets `node_modules` (or any other generated folder,
// tracked or not) still group by name exactly like before, now for free from git itself instead
// of this module's own recursive bucketing. `.git` (a file in a linked worktree) is never
// listed: it is git's own control pointer, never surfaced by `git status` at all, so no
// special-case skip is needed for it either.
//
// `-z` (NUL-terminated records, no quoting) is parsed directly: paths are always forward-slash
// and repository-root-relative (the worktree root, since this runs with `cwd` set to the
// worktree itself), so no separator translation is needed before building a real filesystem
// path from one.
//
// Still never follows a link (symlink or junction, decided the same way `fs::remove_tree`
// decides it -- `symlink_metadata`'s own `is_symlink()`) when counting files inside a matched
// generated-folder bucket: a generated folder that is ITSELF a link reports as a zero-count
// "other" entry (git never emits a trailing `/` for a symlinked directory, so it never matches
// the directory-bucketing branch below), and any link found while counting a real one's contents
// counts as zero of its own and is not descended -- matching `fs::remove_tree`'s own "never
// descend through a link" rule, so this summary never promises to delete more than that module
// will actually touch.
//
// Gate round 1 item 5: the walk is now cancellable. `sessions.delete` calls `cancel_and_wait`
// before its own holder preflight runs, so Refract's own open file handles during "Checking
// files..." can never be mistaken for an external holder. The `git status` call itself is a
// single external process invocation (not meaningfully cancellable mid-flight, and fast
// regardless of tree size since it never expands an ignored/untracked directory's own
// contents); the part that can genuinely run long against a 156k-file `node_modules` is the
// per-bucket file count below, which is where the cooperative cancel flag is actually checked.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Notify;

use crate::git::git::git_raw;

/// Well-known directory names this summary buckets by NAME (merging every occurrence anywhere
/// in the tree into one entry with a combined file count) rather than listing each one
/// individually by path -- the issue's own example, plus the other common ones a Node/Rust/
/// Python toolchain leaves behind in a worktree.
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

/// Caps how many individual "other" entries this summary lists by path before folding the rest
/// into `more_count` -- the issue's own "capped list with 'and N more'".
const MAX_OTHER_FILES_LISTED: usize = 50;

/// `git status` over a worktree never needs to expand an ignored/untracked directory's own
/// contents (that is exactly what `--untracked-files=normal` avoids), so even a 156k-file
/// `node_modules` tree resolves in milliseconds; generous purely as a defence against a stalled
/// git process (a slow disk, antivirus scan) rather than an expectation of ever being hit.
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
    pub generated_folders: Vec<GeneratedFolderEntry>,
    pub other_files: Vec<String>,
    pub more_count: u64,
}

impl LeftoverSummary {
    fn empty() -> Self {
        Self {
            generated_folders: Vec::new(),
            other_files: Vec::new(),
            more_count: 0,
        }
    }
}

/// Counts every real file under `dir` (never following a link), for one matched generated-folder
/// bucket. A link anywhere inside counts as zero of its own contents -- consistent with
/// `fs::remove_tree` never descending through one either. Checks `cancel` between entries so a
/// cancelled walk against a huge bucket returns promptly rather than running to completion
/// (issue #891 gate round 1 item 5); a cancelled count is simply whatever was tallied so far --
/// this summary is purely informational, so an undercount from an aborted walk costs nothing a
/// stale "Checking files..." count would not already have cost.
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

/// Parses one `git status --porcelain=v1 -z --ignored --untracked-files=normal` record stream
/// (already split on `\0` by the caller) into the summary shape, counting each matched
/// generated-folder bucket's real files on disk (`git status` reports only that the directory
/// itself is untracked/ignored, never a file count).
fn build_summary(worktree_path: &Path, porcelain: &str, cancel: &AtomicBool) -> LeftoverSummary {
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

        if is_dir && GENERATED_FOLDER_NAMES.contains(&basename) {
            let full = worktree_path.join(trimmed);
            let count = count_files(&full, cancel);
            *generated.entry(basename.to_string()).or_insert(0) += count;
        } else if other_files.len() < MAX_OTHER_FILES_LISTED {
            other_files.push(trimmed.to_string());
        } else {
            more_count += 1;
        }
    }

    LeftoverSummary {
        generated_folders: generated
            .into_iter()
            .map(|(name, file_count)| GeneratedFolderEntry { name, file_count })
            .collect(),
        other_files,
        more_count,
    }
}

/// Issue #891 gate round 1 item 5: a process-wide registry of in-flight summary walks, keyed by
/// Session id, so `sessions.delete` can cancel and await THIS Session's own walk (if one is
/// running) before its holder preflight checks for external handles. `Notify::notify_one`
/// (never `notify_waiters`) is the deliberate choice: it buffers exactly one permit for a
/// `notified()` future created before the notification arrives, which is the pattern
/// `cancel_and_wait` below relies on (its own doc comment) -- `notify_waiters` only wakes
/// callers ALREADY suspended in `.await` at the exact instant it is called, which could lose a
/// notification that arrives between `cancel_and_wait`'s lookup and its first `.await`.
type RegistryEntry = (Arc<AtomicBool>, Arc<Notify>);
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, RegistryEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Runs the background walk for `session_id`'s worktree, registering a cancellable flag for the
/// duration so `cancel_and_wait` can stop it early. An empty summary for a worktree folder that
/// is not actually there (nothing to report).
pub async fn compute_leftover_summary(session_id: &str, worktree_path: &Path) -> LeftoverSummary {
    if tokio::fs::symlink_metadata(worktree_path).await.is_err() {
        return LeftoverSummary::empty();
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    {
        let mut registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        registry.insert(session_id.to_string(), (cancel.clone(), notify.clone()));
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

    let summary = if raw.code != 0 {
        LeftoverSummary::empty()
    } else {
        let path = worktree_path.to_path_buf();
        let cancel_for_count = cancel.clone();
        tokio::task::spawn_blocking(move || build_summary(&path, &raw.stdout, &cancel_for_count))
            .await
            .unwrap_or_else(|_| LeftoverSummary::empty())
    };

    {
        let mut registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        registry.remove(session_id);
    }
    notify.notify_one();
    summary
}

/// Issue #891 gate round 1 item 5: "Delete during 'Checking files…': the summary walk becomes
/// cancellable; Delete stops it and waits for it to exit before any holder check, so Refract
/// never refuses because of its own open handles." Sets the cooperative cancel flag
/// `count_files`/`build_summary` check, then waits for that in-flight `compute_leftover_summary`
/// call to actually return and deregister -- a no-op (returns immediately) if no summary walk is
/// currently running for this Session.
///
/// The `notify.notified()` future is created BEFORE each registry re-check (the standard safe
/// `tokio::sync::Notify` idiom for "wait until a condition becomes false"): this guarantees a
/// `notify_one()` call that races with the check is never missed, since `notify_one` buffers its
/// permit for the next `notified()` poll regardless of whether that poll has already started
/// waiting.
pub async fn cancel_and_wait(session_id: &str) {
    let (cancel, notify) = {
        let registry = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned");
        match registry.get(session_id) {
            Some((cancel, notify)) => (cancel.clone(), notify.clone()),
            None => return,
        }
    };
    cancel.store(true, Ordering::Relaxed);
    loop {
        let notified = notify.notified();
        let still_running = IN_FLIGHT
            .lock()
            .expect("leftover summary registry poisoned")
            .contains_key(session_id);
        if !still_running {
            return;
        }
        notified.await;
    }
}
