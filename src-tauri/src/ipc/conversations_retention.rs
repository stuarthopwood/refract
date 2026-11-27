// Opt-in Conversation retention (#2161, FR-189): `conversations.retentionPreview` lists what the
// setting would delete, `conversations.retentionRun` deletes it. Both are user-triggered, read the
// stored setting, and do nothing while it is off. Age is the file's modified time; every delete goes
// through `delete_conversation_core`, so it keeps all of that command's refusals.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use super::conversations::{parse_file_name, same_file};
use super::conversations_delete::{delete_conversation_core, omp_sessions_root};
use super::conversations_size::conversation_size_bytes;
use super::sessions_lifecycle::delete_in_flight;
use super::{AppState, Dispatcher, HandlerFuture, IpcError};
use crate::fs::remove_tree::{checked_canonical_path, ContainmentCheck};
use crate::git::worktree_validity::comparable_path;
use crate::session::SessionStatus;
use crate::store::settings::ConversationRetention;

pub fn register(d: &mut Dispatcher) {
    d.register("conversations.retentionPreview", retention_preview_handler);
    d.register("conversations.retentionRun", retention_run_handler);
}

const SECONDS_PER_DAY: u64 = 86_400;

/// One Conversation the setting would delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionCandidate {
    pub(crate) session_id: String,
    pub(crate) file: String,
    pub(crate) size_bytes: u64,
    pub(crate) modified_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionPreview {
    pub(crate) enabled: bool,
    pub(crate) days: u32,
    pub(crate) candidates: Vec<RetentionCandidate>,
    pub(crate) total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionRun {
    pub(crate) enabled: bool,
    pub(crate) days: u32,
    pub(crate) deleted: u64,
    pub(crate) failed: u64,
    pub(crate) bytes_freed: u64,
}

/// Sessions sharing one `session_dir` (the Personal Agent's Sessions share a folder).
struct Folder {
    session_id: String,
    dir: PathBuf,
    current: Vec<String>,
}

/// Folders whose every Session is idle or stopped and not being deleted; a folder with one busy
/// Session is skipped whole, because its files cannot be told apart from that Session's own.
async fn eligible_folders(state: &AppState) -> Vec<Folder> {
    let sessions = state.registry.lock().await.snapshot().sessions;
    let mut groups: BTreeMap<String, (Folder, bool)> = BTreeMap::new();
    for session in &sessions {
        let Some(dir) = session.session_dir.as_deref() else {
            continue;
        };
        let status = match state.session_manager.get_agent(&session.id) {
            Some(agent) => agent.status().await,
            None => SessionStatus::Stopped,
        };
        let quiet = matches!(status, SessionStatus::Idle | SessionStatus::Stopped)
            && !delete_in_flight::is_deleting(&session.id);
        let (folder, all_quiet) = groups.entry(comparable_path(dir)).or_insert_with(|| {
            (
                Folder {
                    session_id: session.id.clone(),
                    dir: PathBuf::from(dir),
                    current: Vec::new(),
                },
                true,
            )
        });
        *all_quiet &= quiet;
        folder.current.extend(session.current_conversation.clone());
    }
    groups
        .into_values()
        .filter(|(_, all_quiet)| *all_quiet)
        .map(|(folder, _)| folder)
        .collect()
}

/// Blocking: the aged, non-current Conversation files of one folder strictly inside `root`.
fn scan_folder(folder: &Folder, root: &Path, cutoff: SystemTime) -> Vec<RetentionCandidate> {
    if !matches!(
        checked_canonical_path(&folder.dir, root),
        ContainmentCheck::Ok(_)
    ) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&folder.dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if parse_file_name(&name).is_none() {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if !meta.is_file() || modified > cutoff {
            continue;
        }
        let file = path.to_string_lossy().into_owned();
        if folder
            .current
            .iter()
            .any(|current| same_file(current, &file))
        {
            continue;
        }
        found.push(RetentionCandidate {
            session_id: folder.session_id.clone(),
            size_bytes: conversation_size_bytes(&path),
            modified_at_ms: modified
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|age| u64::try_from(age.as_millis()).ok())
                .unwrap_or(0),
            file,
        });
    }
    found.sort_by(|a, b| {
        a.modified_at_ms
            .cmp(&b.modified_at_ms)
            .then(a.file.cmp(&b.file))
    });
    found
}

async fn find_candidates(
    state: &AppState,
    root: &Path,
    days: u32,
    now: SystemTime,
) -> Vec<RetentionCandidate> {
    let Some(cutoff) = now.checked_sub(Duration::from_secs(u64::from(days) * SECONDS_PER_DAY))
    else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for folder in eligible_folders(state).await {
        let root = root.to_path_buf();
        let scanned = tokio::task::spawn_blocking(move || scan_folder(&folder, &root, cutoff))
            .await
            .unwrap_or_default();
        found.extend(scanned);
    }
    found
}

/// What `retention` would delete now; nothing while it is off.
pub(crate) async fn preview_core(
    state: &AppState,
    root: &Path,
    retention: ConversationRetention,
    now: SystemTime,
) -> RetentionPreview {
    let candidates = if retention.enabled {
        find_candidates(state, root, retention.days, now).await
    } else {
        Vec::new()
    };
    RetentionPreview {
        enabled: retention.enabled,
        days: retention.days,
        total_bytes: candidates.iter().map(|c| c.size_bytes).sum(),
        candidates,
    }
}

/// Deletes what `preview_core` lists, one Conversation at a time; a refusal or failure on one
/// (it became current, its Session got busy) is counted and the run carries on.
pub(crate) async fn run_core(
    state: &AppState,
    root: &Path,
    retention: ConversationRetention,
    now: SystemTime,
) -> RetentionRun {
    let mut run = RetentionRun {
        enabled: retention.enabled,
        days: retention.days,
        deleted: 0,
        failed: 0,
        bytes_freed: 0,
    };
    if !retention.enabled {
        return run;
    }
    let mut seen = HashSet::new();
    for candidate in find_candidates(state, root, retention.days, now).await {
        if !seen.insert(comparable_path(&candidate.file)) {
            continue;
        }
        match delete_conversation_core(state, &candidate.session_id, &candidate.file, root).await {
            Ok(bytes) => {
                run.deleted += 1;
                run.bytes_freed += bytes;
            }
            Err(err) => {
                run.failed += 1;
                log::warn!(
                    "conversations.retentionRun: kept {}: {}",
                    candidate.file,
                    err.message
                );
            }
        }
    }
    run
}

async fn stored_retention(state: &AppState) -> Result<(ConversationRetention, PathBuf), IpcError> {
    let retention = state.settings.lock().await.get().conversation_retention;
    let root = omp_sessions_root()
        .ok_or_else(|| IpcError::new("delete-failed", "The home folder could not be found."))?;
    Ok((retention, root))
}

fn retention_preview_handler(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (retention, root) = stored_retention(&state).await?;
        let preview = preview_core(&state, &root, retention, SystemTime::now()).await;
        Ok(serde_json::to_value(preview).expect("RetentionPreview is always JSON-serialisable"))
    })
}

fn retention_run_handler(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (retention, root) = stored_retention(&state).await?;
        let run = run_core(&state, &root, retention, SystemTime::now()).await;
        Ok(serde_json::to_value(run).expect("RetentionRun is always JSON-serialisable"))
    })
}

#[cfg(test)]
#[path = "conversations_retention.test.rs"]
mod tests;
