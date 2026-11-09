// IPC handlers for `gitChanges.*`: list, stage/unstage, stageAll/unstageAll, commit, diff, and watcher lifecycle.
// Mutating handlers call `session::readout::schedule_readout_update` so the readout's `changes` chip stays current.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::fs::git_changes_watch_state as watch_state;
use crate::fs::worktree_access::read_guard_bounded;
use crate::git::changes_diff::diff_text;
use crate::git::changes_status::{
    commit as git_commit, read_changes_status, stage_files, unstage_files,
};
use crate::git::git::{GitError, GitErrorCode};
use crate::session::readout::schedule_readout_update;

use super::{
    arg_str, invalid_argument, map_git_error, not_found, AppState, Dispatcher, HandlerFuture,
    IpcError,
};

const MAX_SESSION_ID_LENGTH: usize = 256;
/// Matches `ipc::file_explorer`'s path cap; kept separate so the two can change independently.
const MAX_PATH_LENGTH: usize = 4096;
/// Bounds paths per `stage`/`unstage` call to cap request size.
const MAX_PATHS_PER_CALL: usize = 10_000;
/// Caps commit message length; git does not enforce one on stdin.
const MAX_COMMIT_MESSAGE_LENGTH: usize = 100_000;
/// Caps the group name; the exact match in `stageAll` rejects anything else.
const MAX_GROUP_LENGTH: usize = 32;

pub fn register(d: &mut Dispatcher) {
    d.register("gitChanges.list", git_changes_list);
    d.register("gitChanges.stage", git_changes_stage);
    d.register("gitChanges.unstage", git_changes_unstage);
    d.register("gitChanges.stageAll", git_changes_stage_all);
    d.register("gitChanges.unstageAll", git_changes_unstage_all);
    d.register("gitChanges.commit", git_changes_commit);
    d.register("gitChanges.diff", git_changes_diff);
    d.register("gitChanges.ensureWatching", git_changes_ensure_watching);
    d.register("gitChanges.stopWatching", git_changes_stop_watching);
}

fn require_str(
    args: &[Value],
    index: usize,
    max_len: usize,
    type_msg: &'static str,
    size_msg: &'static str,
) -> Result<String, IpcError> {
    match arg_str(args, index) {
        Some(s) if s.len() <= max_len => Ok(s.to_string()),
        Some(_) => Err(invalid_argument(size_msg)),
        None => Err(invalid_argument(type_msg)),
    }
}

fn require_paths(
    args: &[Value],
    index: usize,
    type_msg: &'static str,
) -> Result<Vec<String>, IpcError> {
    let raw = args
        .get(index)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_argument(type_msg))?;
    if raw.len() > MAX_PATHS_PER_CALL {
        return Err(invalid_argument(
            "This request named too many paths at once",
        ));
    }
    let mut paths = Vec::with_capacity(raw.len());
    for value in raw {
        let s = value.as_str().ok_or_else(|| invalid_argument(type_msg))?;
        if s.len() > MAX_PATH_LENGTH {
            return Err(invalid_argument("This request named an oversized path"));
        }
        paths.push(s.to_string());
    }
    Ok(paths)
}

/// Looks up a Session's worktree and Base branch; `Err(not_found)` only when the Session is gone.
async fn session_context(
    state: &AppState,
    session_id: &str,
) -> Result<(PathBuf, String, bool), IpcError> {
    let registry = state.registry.lock().await;
    let session = registry
        .get_session(session_id)
        .ok_or_else(|| not_found("This Session no longer exists"))?;
    Ok((
        PathBuf::from(&session.worktree_path),
        session.base_branch.clone(),
        session.archived_at.is_some(),
    ))
}

pub fn git_changes_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.list expects a string sessionId",
            "gitChanges.list rejected an oversized sessionId",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        // Never throws: `None` means a normal "not available" state, not an IPC error.
        let snapshot = match read_guard_bounded(&session_id).await {
            Ok(_guard) => read_changes_status(&worktree_path, &base_branch).await,
            Err(_) => None,
        };
        Ok(json!({ "snapshot": snapshot }))
    })
}

pub fn git_changes_stage(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stage expects a string sessionId and a string[] paths",
            "gitChanges.stage rejected an oversized sessionId",
        )?;
        let paths = require_paths(
            &args,
            1,
            "gitChanges.stage expects a string sessionId and a string[] paths",
        )?;
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        {
            let _guard = read_guard_bounded(&session_id)
                .await
                .map_err(map_git_error)?;
            stage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
        }
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

pub fn git_changes_unstage(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.unstage expects a string sessionId and a string[] paths",
            "gitChanges.unstage rejected an oversized sessionId",
        )?;
        let paths = require_paths(
            &args,
            1,
            "gitChanges.unstage expects a string sessionId and a string[] paths",
        )?;
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        {
            let _guard = read_guard_bounded(&session_id)
                .await
                .map_err(map_git_error)?;
            unstage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
        }
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

/// Stages all of `group` ('changes' or 'untracked'), re-reading its status server-side.
pub fn git_changes_stage_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stageAll expects a string sessionId and a string group",
            "gitChanges.stageAll rejected an oversized sessionId",
        )?;
        let group = require_str(
            &args,
            1,
            MAX_GROUP_LENGTH,
            "gitChanges.stageAll expects a string sessionId and a string group",
            "gitChanges.stageAll rejected an oversized group",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        {
            let _guard = read_guard_bounded(&session_id)
                .await
                .map_err(map_git_error)?;
            let Some(snapshot) = read_changes_status(&worktree_path, &base_branch).await else {
                // A `None` status read is an error here, never a silent success.
                return Err(map_git_error(GitError::new(
                    GitErrorCode::GitFailed,
                    "Couldn't read this worktree's Git status",
                )));
            };
            let paths: Vec<String> = match group.as_str() {
                "changes" => snapshot
                    .groups
                    .changes
                    .into_iter()
                    .map(|entry| entry.path)
                    .collect(),
                "untracked" => snapshot
                    .groups
                    .untracked
                    .into_iter()
                    .map(|entry| entry.path)
                    .collect(),
                _ => {
                    return Err(invalid_argument(
                        "gitChanges.stageAll group must be \"changes\" or \"untracked\"",
                    ))
                }
            };
            stage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
        }
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

pub fn git_changes_unstage_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.unstageAll expects a string sessionId",
            "gitChanges.unstageAll rejected an oversized sessionId",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        {
            let _guard = read_guard_bounded(&session_id)
                .await
                .map_err(map_git_error)?;
            let Some(snapshot) = read_changes_status(&worktree_path, &base_branch).await else {
                // Same as the stageAll branch: a failed status read must not look like success.
                return Err(map_git_error(GitError::new(
                    GitErrorCode::GitFailed,
                    "Couldn't read this worktree's Git status",
                )));
            };
            let paths: Vec<String> = snapshot
                .groups
                .staged
                .into_iter()
                .map(|entry| entry.path)
                .collect();
            unstage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
        }
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

pub fn git_changes_commit(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.commit expects a string sessionId and a string message",
            "gitChanges.commit rejected an oversized sessionId",
        )?;
        let message = require_str(
            &args,
            1,
            MAX_COMMIT_MESSAGE_LENGTH,
            "gitChanges.commit expects a string sessionId and a string message",
            "gitChanges.commit rejected an oversized message",
        )?;
        if message.trim().is_empty() {
            return Err(invalid_argument(
                "gitChanges.commit requires a non-empty message",
            ));
        }
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        {
            let _guard = read_guard_bounded(&session_id)
                .await
                .map_err(map_git_error)?;
            git_commit(&worktree_path, &message)
                .await
                .map_err(map_git_error)?;
        }
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

/// Returns one file's diff; `untracked` files are synthesised as added lines, with the path resolved symlink-safely.
/// A symlink leaf is shown as its target text, never followed.
pub fn git_changes_diff(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.diff expects a string sessionId, a string path, a boolean staged and a boolean untracked",
            "gitChanges.diff rejected an oversized sessionId",
        )?;
        let path = require_str(
            &args,
            1,
            MAX_PATH_LENGTH,
            "gitChanges.diff expects a string sessionId, a string path, a boolean staged and a boolean untracked",
            "gitChanges.diff rejected an oversized path",
        )?;
        let staged = args.get(2).and_then(Value::as_bool).unwrap_or(false);
        let untracked = args.get(3).and_then(Value::as_bool).unwrap_or(false);
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        // A refused guard surfaces as the busy error: the diff `reason` set is a closed wire enum (#1157).
        let _guard = read_guard_bounded(&session_id)
            .await
            .map_err(map_git_error)?;
        let (patch, reason) = diff_text(&worktree_path, &path, staged, untracked)
            .await
            .map_err(map_git_error)?;
        Ok(json!({ "patch": patch, "reason": reason }))
    })
}

pub fn git_changes_ensure_watching(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.ensureWatching expects a string sessionId",
            "gitChanges.ensureWatching rejected an oversized sessionId",
        )?;
        let (worktree_path, _base_branch, archived) = session_context(&state, &session_id).await?;
        watch_state::ensure_watcher(
            state.app_handle.clone(),
            &session_id,
            &worktree_path,
            archived,
        );
        Ok(Value::Null)
    })
}

pub fn git_changes_stop_watching(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stopWatching expects a string sessionId",
            "gitChanges.stopWatching rejected an oversized sessionId",
        )?;
        watch_state::stop_watcher(&session_id);
        Ok(Value::Null)
    })
}
