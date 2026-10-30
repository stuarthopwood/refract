// Read-only Session handlers split from `sessions_lifecycle.rs` (#806): `sessions.diffStat` and
// `sessions.revealWorktree`. `pub(super)`: registered by the parent's `register()` only.

use serde_json::Value;
use std::path::Path;

use crate::git::diff_stat::diff_stat;
use crate::process::executables::explorer_exe_path;

use super::super::{arg_str, invalid_argument, not_found, AppState, HandlerFuture, IpcError};

/// `sessions.diffStat`: always `Ok`, with `null` for a timeout, missing worktree, missing Base
/// branch or any git failure.
pub(super) fn sessions_diff_stat(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.diffStat expects a string id")),
        };
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        let result = diff_stat(Path::new(&session.worktree_path), &session.base_branch).await;
        Ok(serde_json::to_value(result).expect("Option<DiffStatResult> is always serialisable"))
    })
}

/// `sessions.revealWorktree`: looks the worktree up by Session id, never a renderer path. Spawns
/// `explorer.exe` by its fixed `%SystemRoot%` path, avoiding PATH/cwd search; Windows-only build.
pub(super) fn sessions_reveal_worktree(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.revealWorktree expects a string id",
                ))
            }
        };
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        let worktree_is_directory = tokio::fs::metadata(&session.worktree_path)
            .await
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        if !worktree_is_directory {
            return Err(IpcError::new(
                "worktree-missing",
                format!("Worktree missing: {}", session.worktree_path),
            ));
        }
        match tokio::process::Command::new(explorer_exe_path())
            .arg(&session.worktree_path)
            .spawn()
        {
            Ok(_) => Ok(Value::Null),
            Err(err) => Err(IpcError::new("worktree-failed", err.to_string())),
        }
    })
}
