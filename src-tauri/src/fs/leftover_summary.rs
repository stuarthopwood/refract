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
    /// Issue #891 gate round (M3): the worktree folder's own basename, so the renderer can lead
    /// each displayed path with "the Session folder name" rather than a bare worktree-relative
    /// path with no indication of which Session it belongs to.
    pub root_name: String,
    pub generated_folders: Vec<GeneratedFolderEntry>,
    pub other_files: Vec<String>,
    pub more_count: u64,
    /// Issue #891 gate round 2 (H2): true when the underlying `git status` call failed, timed
    /// out, or its `spawn_blocking` join itself failed -- as opposed to a worktree that
    /// genuinely has nothing left. Collapsing both into the same empty-looking shape told the
    /// dialog "Nothing left in the worktree" when the real answer was "unknown" (confirmed by
    /// scenario (b): an unregistered leftover folder with no usable `.git` makes every `git
    /// status` call fail, yet the folder can still hold thousands of real files). Renderer
    /// shows "Couldn't list the folder's files." instead of a summary whenever this is true.
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

    /// The underlying `git status` read failed, timed out, or its `spawn_blocking` join failed
    /// -- distinct from `empty`, which means the walk genuinely found nothing to report.
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
///
/// Live-check gate round fix: git's own untracked/ignored collapsing happens at the TOP of a
/// newly-untracked subtree, not necessarily at a generated folder living somewhere inside it --
/// a `node_modules` nested a few levels down (e.g. `patient/client/node_modules`) under a
/// directory that is ITSELF entirely new (`patient/`) collapses to ONE line for `patient/`,
/// never `patient/client/node_modules/`, so checking only the reported entry's own basename
/// missed it entirely (confirmed live: scenario (a)'s own nested fixture). When a reported
/// directory's basename does NOT itself match a generated-folder name, `walk_for_generated`
/// below walks INTO it (never through a link) to find any nested one, bucketing by name exactly
/// as if git had reported it directly, and lists every other real file under it individually by
/// path -- never walking through a link, same rule as `count_files`.
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
        // Issue #891 gate round 3 (M5): a cancelled walk must never return a complete-looking
        // summary built from whatever partial counts it reached before the flag was set --
        // `unavailable` is the only honest shape for "we don't actually know what's left",
        // same as a failed/timed-out `git status` call (H2).
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

/// Walks `dir` (a real directory git reported as one collapsed untracked/ignored entry whose OWN
/// basename did not match a generated-folder name) looking for a nested one at any depth: a
/// matching subdirectory is bucketed by name (its own files counted, never descended into
/// individually); everything else real is listed by its path relative to `worktree_path`. Never
/// follows a link (symlink or junction) -- it counts as one "other" entry at its own path,
/// matching `count_files`'s identical rule.
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

/// Issue #891 gate round 1 item 5: a process-wide registry of in-flight summary walks, keyed by
/// Session id, so `sessions.delete` can cancel and await THIS Session's own walk(s) (if any are
/// running) before its holder preflight checks for external handles. Issue #891 gate round 2
/// (M3): a `Vec` per Session, not a single entry -- two walks for the SAME Session can be in
/// flight at once (a rapid reopen or Retry starting a fresh `deleteLeftoverSummary` call while
/// a previous one is still finishing), and a single `HashMap<String, RegistryEntry>` let the
/// second `.insert` silently overwrite the first walk's own entry, so whichever walk finished
/// FIRST would then deregister the SECOND, still-running walk's entry out from under it --
/// exactly the false-holder race this whole mechanism exists to prevent. Each walk is
/// identified by `Arc::ptr_eq` on its own `cancel` flag, never by `session_id` alone, so it only
/// ever removes its OWN entry (`RegistryGuard`'s own `Drop` impl, below).
///
/// `Notify::notify_one` (never `notify_waiters`) is the deliberate choice: it buffers exactly
/// one permit for a `notified()` future created before the notification arrives, which is the
/// pattern `cancel_and_wait` below relies on (its own doc comment) -- `notify_waiters` only
/// wakes callers ALREADY suspended in `.await` at the exact instant it is called, which could
/// lose a notification that arrives between `cancel_and_wait`'s lookup and its first `.await`.
/// Safe per-walk: each walk's own `Notify` is never shared with any other walk's.
type RegistryEntry = (Arc<AtomicBool>, Arc<Notify>);
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Vec<RegistryEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Issue #891 gate round 2 (M3): deregisters exactly ONE walk's own entry when dropped --
/// identified by `Arc::ptr_eq`, never by `session_id` alone -- so a cancelled, panicked, or
/// otherwise dropped `compute_leftover_summary` future can never leave a stale entry behind.
/// Without this, dropping that future mid-poll (its own enclosing IPC call aborted or timed
/// out) would skip the plain cleanup code at the end of the function entirely, and a LATER
/// `cancel_and_wait` call for the same Session would then spin forever waiting for a
/// `notify_one` that walk will now never send. Gate round 3: also sets `cancel` on drop -- if
/// this future itself is dropped while `build_summary`'s own `spawn_blocking` closure is still
/// running on its own thread (a hard-abort cannot stop that thread, only a dropped `JoinHandle`
/// future stops AWAITING it), the closure's own `cancel_for_count` clone still sees it and
/// winds down sooner instead of running to completion pointlessly.
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

/// Runs the background walk for `session_id`'s worktree, registering a cancellable flag for the
/// duration so `cancel_and_wait` can stop it early. An empty summary for a worktree folder that
/// is not actually there (nothing to report).
pub async fn compute_leftover_summary(session_id: &str, worktree_path: &Path) -> LeftoverSummary {
    // Issue #891 gate round 3 (H1): held for this whole call -- `sessions.delete`'s own write
    // guard blocks until this releases, so Refract's own git/filesystem reads can never race
    // the actual removal. Acquired before anything else, including the registry registration
    // just below, so there is no window at all where this walk is doing real work unprotected.
    let _read_guard = crate::fs::worktree_access::read_guard(session_id).await;

    // Issue #891 gate round 3 (M1): registered, and this guard created, BEFORE the first
    // `await` below (previously after it) -- `cancel_and_wait` sees a registered entry the
    // MOMENT this function is first polled at all, closing a window where a caller could race
    // ahead believing no walk is running yet, when one is about to start doing real git/
    // filesystem work against this exact worktree.
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
        // Issue #891 gate round 2 (H2): a failed/timed-out `git status` means "we don't know",
        // never "nothing left" -- `raw.code` is non-zero both for a genuine git failure (e.g.
        // scenario (b)'s unregistered folder, where `.git` no longer resolves) and for the
        // timeout branch of `git_raw` itself.
        return LeftoverSummary::unavailable(root_name);
    }
    let path = worktree_path.to_path_buf();
    let cancel_for_count = cancel.clone();
    tokio::task::spawn_blocking(move || build_summary(&path, &raw.stdout, &cancel_for_count))
        .await
        .unwrap_or_else(|_| LeftoverSummary::unavailable(root_name))
    // `_guard`/`_read_guard` drop here (or on an early return above, or if this whole future is
    // itself dropped before completing), deregistering this walk's own entry, firing its
    // `notify` exactly once either way, and releasing the read guard for `sessions.delete`'s
    // own write guard to acquire.
}

/// Issue #891 gate round 1 item 5: "Delete during 'Checking files…': the summary walk becomes
/// cancellable; Delete stops it and waits for it to exit before any holder check, so Refract
/// never refuses because of its own open handles." Sets the cooperative cancel flag on EVERY
/// walk currently registered for `session_id` (gate round 2, M3: there may be more than one),
/// then waits for each to actually deregister -- a no-op (returns immediately, no log line) if
/// no summary walk is currently running for this Session.
///
/// The `notify.notified()` future is created BEFORE each registry re-check (the standard safe
/// `tokio::sync::Notify` idiom for "wait until a condition becomes false"): this guarantees a
/// `notify_one()` call that races with the check is never missed, since `notify_one` buffers its
/// permit for the next `notified()` poll regardless of whether that poll has already started
/// waiting.
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
    // Issue #891 gate round 2 (H4, Main's own request): logged ONLY when a walk was actually
    // found and cancelled -- scenario (f)'s own overlap proof needs a line that is genuinely
    // absent whenever this call is a no-op, not one that always fires regardless of outcome.
    log::debug!(
        "leftover_summary::cancel_and_wait: cancelling {} in-flight walk(s) for {session_id}",
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

/// Diagnostic-only (Main's own request, root-causing the "folder in use" refusal): true if a
/// summary walk is STILL registered (not yet finished/deregistered) for `session_id`.
/// `sessions.delete` already calls `cancel_and_wait` before its own holder preflight runs, so
/// this should always read `false` by the time `worktree_holders::check_folder_in_use` logs it
/// -- if it ever reads `true` there, that disagreement IS the bug, not a race this function
/// itself introduces.
pub fn is_walk_in_flight(session_id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .expect("leftover summary registry poisoned")
        .contains_key(session_id)
}
