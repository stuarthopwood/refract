// Read-only/diagnostic Session handlers split out of the parent `sessions_lifecycle.rs` (#806
// "No god files"): `sessions.diffStat` (T068) and `sessions.revealWorktree` (T068) never touch
// a Session's own lifecycle (create/archive/restore/delete/recreate) -- both only look an
// existing worktree up by Session id and either diff it or hand it to Explorer -- so they split
// cleanly out of the file that otherwise owns every lifecycle transition, the same way
// `omp/transcript.rs`'s own `file_attachment_markers` submodule splits out one self-contained
// concern (#926). `pub(super)` throughout: registered by the parent's own `register()`, never a
// second direct entry point in `ipc/mod.rs`.

use serde_json::Value;
use std::path::Path;

use crate::git::diff_stat::diff_stat;
use crate::process::executables::explorer_exe_path;

use super::super::{arg_str, invalid_argument, not_found, AppState, HandlerFuture, IpcError};

/// `sessions.diffStat` (T068): read-only, so `diff_stat` itself never throws past its own
/// boundary -- this handler's own `Result` is always `Ok`, carrying `null` for a timeout, a
/// missing worktree, a missing Base branch, or any git failure.
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

/// `sessions.revealWorktree` (T068): looks the worktree up by Session id in the registry, never
/// a path handed in by the renderer (constitution V). No `tauri_plugin_opener`/`shell.openPath`
/// equivalent is called from Rust elsewhere in this crate yet, so this spawns Windows'
/// `explorer.exe` via its fixed `%SystemRoot%` path (`process::executables::explorer_exe_path`),
/// never the bare name `"explorer"` -- same PATH/cwd-search-avoidance reasoning `git::git`'s own
/// `which` doc comment documents. This build is Windows-only, per `git::git`'s own
/// `CREATE_NO_WINDOW` comment.
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
