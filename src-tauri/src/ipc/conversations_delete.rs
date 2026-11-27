// `conversations.delete`: removes one Conversation's `.jsonl` and artifact folder from the OMP
// Sessions folder. `delete_conversation_core` takes the Sessions root as a parameter so tests use temp
// dirs and so retention can share the exact same refusals.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde_json::Value;

use super::conversations::{parse_file_name, same_file};
use super::conversations_size::{artifact_dir, conversation_size_bytes};
use super::sessions_lifecycle::delete_in_flight;
use super::{invalid_argument, not_found, AppState, HandlerFuture, IpcError};
use crate::fs::remove_tree::{
    checked_canonical_path, remove_file, remove_tree, ContainmentCheck, RemoveTreeError,
};
use crate::git::worktree_validity::comparable_path;
use crate::session::SessionStatus;

static FILES_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// A poisoned lock only means another thread panicked mid-insert; the set itself is still valid.
fn files_in_flight() -> MutexGuard<'static, HashSet<String>> {
    FILES_IN_FLIGHT
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

/// Holds one Conversation file in the in-flight set until dropped.
struct FileClaim {
    key: String,
}

impl Drop for FileClaim {
    fn drop(&mut self) {
        files_in_flight().remove(&self.key);
    }
}

fn claim_file(file: &str) -> Result<FileClaim, IpcError> {
    let key = comparable_path(file);
    if !files_in_flight().insert(key.clone()) {
        return Err(IpcError::new(
            delete_in_flight::ALREADY_DELETING,
            "This Conversation is already being deleted.",
        ));
    }
    Ok(FileClaim { key })
}

/// OMP's Sessions folder, the only boundary a Conversation delete may act inside. Debug builds
/// follow the `REFRACT_OMP_SESSIONS_DIR` override the usage reader honours, so a scratch run never
/// touches the real folder (on Windows the home folder cannot be redirected through the
/// environment). Release builds ignore it: a stray variable must not move the delete boundary.
pub(crate) fn omp_sessions_root() -> Option<PathBuf> {
    let raw = if cfg!(debug_assertions) {
        std::env::var("REFRACT_OMP_SESSIONS_DIR").ok()
    } else {
        None
    };
    resolve_omp_sessions_root(raw, dirs::home_dir())
}

/// `None` when neither an absolute override nor a home folder exists, never a relative path.
fn resolve_omp_sessions_root(raw: Option<String>, home: Option<PathBuf>) -> Option<PathBuf> {
    Some(crate::usage::paths::resolve_sessions_dir(raw, home)).filter(|dir| dir.is_absolute())
}

/// What a passed check will remove; a part that is already gone is `None`.
struct RemovalPlan {
    jsonl: Option<PathBuf>,
    artifact: Option<PathBuf>,
    bytes: u64,
}

fn refused(what: &str) -> IpcError {
    invalid_argument(format!("Refused: {what}."))
}

fn map_remove_error(err: RemoveTreeError) -> IpcError {
    match err {
        RemoveTreeError::OutsideBoundary => refused("outside the Sessions folder"),
        other => IpcError::new("delete-failed", other.to_string()),
    }
}

/// Resolves one path through the containment gate: `None` is "already gone".
fn contained(path: &Path, root: &Path, what: &str) -> Result<Option<PathBuf>, IpcError> {
    match checked_canonical_path(path, root) {
        ContainmentCheck::Ok(canonical) => Ok(Some(canonical)),
        ContainmentCheck::Missing => Ok(None),
        ContainmentCheck::OutsideBoundary => Err(refused(what)),
        ContainmentCheck::Unreadable(source) => Err(IpcError::new(
            "delete-failed",
            format!("{}: {source}", path.display()),
        )),
    }
}

/// Blocking: every location check, before anything is touched.
fn plan_removal(session_dir: &Path, file: &Path, root: &Path) -> Result<RemovalPlan, IpcError> {
    if file.components().any(|part| part == Component::ParentDir) {
        return Err(refused("the file path is not plain"));
    }
    let valid_name = file
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| parse_file_name(name).is_some());
    let in_session_dir = file
        .parent()
        .is_some_and(|parent| same_file(&parent.to_string_lossy(), &session_dir.to_string_lossy()));
    if !valid_name || !in_session_dir {
        return Err(invalid_argument(
            "conversations.delete file must be one of this Session's own Conversations",
        ));
    }

    let canonical_dir = contained(
        session_dir,
        root,
        "the Session folder is not inside the Sessions folder",
    )?
    .ok_or_else(|| not_found("This Session's folder is gone"))?;
    let jsonl = contained(
        file,
        root,
        "the Conversation file is a link or outside the Sessions folder",
    )?;
    if let Some(canonical) = &jsonl {
        let same_dir = canonical.parent().is_some_and(|parent| {
            comparable_path(&parent.to_string_lossy())
                == comparable_path(&canonical_dir.to_string_lossy())
        });
        if !same_dir {
            return Err(refused("the file does not resolve into the Session folder"));
        }
    }
    let artifact = contained(
        &artifact_dir(file),
        root,
        "the artifact folder is a link or outside the Sessions folder",
    )?;
    Ok(RemovalPlan {
        bytes: conversation_size_bytes(file),
        jsonl,
        artifact,
    })
}

async fn execute(plan: &RemovalPlan, root: &Path) -> Result<(), IpcError> {
    // Artifacts first: if the removal stops midway the `.jsonl` still lists, so the user can retry.
    if let Some(artifact) = &plan.artifact {
        remove_tree(artifact, root)
            .await
            .map_err(map_remove_error)?;
    }
    if let Some(jsonl) = &plan.jsonl {
        remove_file(jsonl, root).await.map_err(map_remove_error)?;
    }
    Ok(())
}

/// Deletes `file` from `session_id`'s Conversations and returns the bytes freed.
/// Refuses the current Conversation (of any Session sharing the folder), a Session that is not
/// idle or stopped, a Session being deleted, a delete already running for the file, and anything
/// not a plain `.jsonl` in the Session's own folder strictly inside `boundary_root`.
pub(crate) async fn delete_conversation_core(
    state: &AppState,
    session_id: &str,
    file: &str,
    boundary_root: &Path,
) -> Result<u64, IpcError> {
    delete_in_flight::refuse_if_deleting(session_id)?;
    let sessions = state.registry.lock().await.snapshot().sessions;
    let session = sessions
        .iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| not_found(format!("Session not found: {session_id}")))?;
    let session_dir = session
        .session_dir
        .as_deref()
        .ok_or_else(|| not_found("This Session has no Conversations"))?;

    let status = match state.session_manager.get_agent(session_id) {
        Some(agent) => agent.status().await,
        None => SessionStatus::Stopped,
    };
    if !matches!(status, SessionStatus::Idle | SessionStatus::Stopped) {
        return Err(IpcError::new(
            "not-idle",
            "Delete Conversations after the current turn.",
        ));
    }
    let is_current_somewhere = sessions.iter().any(|other| {
        other
            .session_dir
            .as_deref()
            .is_some_and(|dir| same_file(dir, session_dir))
            && other
                .current_conversation
                .as_deref()
                .is_some_and(|current| same_file(current, file))
    });
    if is_current_somewhere {
        return Err(IpcError::new(
            "current-conversation",
            "The current Conversation cannot be deleted.",
        ));
    }

    let claim = claim_file(file)?;
    let (session_dir, file_path, root) = (
        PathBuf::from(session_dir),
        PathBuf::from(file),
        boundary_root.to_path_buf(),
    );
    // Its own task, so a dropped request cannot abandon a half-finished removal.
    let removal = tokio::spawn(async move {
        let planning_root = root.clone();
        let plan = tokio::task::spawn_blocking(move || {
            plan_removal(&session_dir, &file_path, &planning_root)
        })
        .await
        .map_err(|err| IpcError::new("delete-failed", err.to_string()))??;
        execute(&plan, &root).await?;
        drop(claim);
        Ok::<u64, IpcError>(plan.bytes)
    })
    .await;
    removal.unwrap_or_else(|err| Err(IpcError::new("delete-failed", err.to_string())))
}

/// `conversations.delete(sessionId, file)` resolves to `{ bytesFreed }`.
pub fn conversations_delete(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (Some(session_id), Some(file)) = (
            args.first().and_then(Value::as_str),
            args.get(1).and_then(Value::as_str),
        ) else {
            return Err(invalid_argument(
                "conversations.delete expects (sessionId, file) strings",
            ));
        };
        let root = omp_sessions_root()
            .ok_or_else(|| IpcError::new("delete-failed", "The home folder could not be found."))?;
        let bytes_freed = delete_conversation_core(&state, session_id, file, &root).await?;
        Ok(serde_json::json!({ "bytesFreed": bytes_freed }))
    })
}

#[cfg(test)]
#[path = "conversations_delete.test.rs"]
mod tests;
