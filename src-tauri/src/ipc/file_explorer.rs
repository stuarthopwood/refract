// IPC handlers for `fileExplorer.*`. Watcher bookkeeping lives in `fs::explorer_watch_state`.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::fs::explorer_watch_state as watch_state;
use crate::fs::list_directory::{list_directory_entries, resolve_list_target, ListDirectoryError};
use crate::fs::read_preview::read_preview as read_preview_file;
use crate::fs::resolve::ResolveReason;
use crate::fs::vscode::{clear_vscode_executable_cache, resolve_vscode_executable};
use crate::git::status::read_git_status;

use super::files::{resolve_error_result, show_item_in_folder};
use super::{arg_str, invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

const MAX_SESSION_ID_LENGTH: usize = 256;
/// Matches `files.rs`'s `MAX_TOKEN_LENGTH`; kept independent so the two call sites never change together.
const MAX_RELATIVE_PATH_LENGTH: usize = 4096;

pub fn register(d: &mut Dispatcher) {
    d.register("fileExplorer.listDirectory", file_explorer_list_directory);
    d.register("fileExplorer.readPreview", file_explorer_read_preview);
    d.register("fileExplorer.getStatus", file_explorer_get_status);
    d.register("fileExplorer.openInVSCode", file_explorer_open_in_vscode);
    d.register("fileExplorer.reveal", file_explorer_reveal);
    d.register("fileExplorer.copyPath", file_explorer_copy_path);
    d.register("fileExplorer.stopWatching", file_explorer_stop_watching);
    d.register("fileExplorer.ensureWatching", file_explorer_ensure_watching);
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

/// Session worktree path, repository path (`None` if removed), and archived flag. `Err` only if the Session is gone.
async fn session_context(
    state: &AppState,
    session_id: &str,
) -> Result<(PathBuf, Option<PathBuf>, bool), IpcError> {
    let registry = state.registry.lock().await;
    let session = registry
        .get_session(session_id)
        .ok_or_else(|| not_found("This Session no longer exists"))?;
    let repo_path = registry
        .get_repository(&session.repository_id)
        .map(|r| PathBuf::from(&r.path));
    Ok((
        PathBuf::from(&session.worktree_path),
        repo_path,
        session.archived_at.is_some(),
    ))
}

fn list_directory_error_to_ipc(err: ListDirectoryError) -> IpcError {
    match err {
        ListDirectoryError::WorktreeMissing => IpcError::new(
            crate::fs::resolve::resolve_reason_code(ResolveReason::WorktreeMissing),
            crate::fs::resolve::resolve_reason_message(ResolveReason::WorktreeMissing, ""),
        ),
        ListDirectoryError::FileMissing(msg) => IpcError::new("file-missing", msg),
        ListDirectoryError::OutsideWorktree => IpcError::new(
            crate::fs::resolve::resolve_reason_code(ResolveReason::OutsideWorktree),
            crate::fs::resolve::resolve_reason_message(ResolveReason::OutsideWorktree, ""),
        ),
        ListDirectoryError::InvalidArgument(msg) => IpcError::new("invalid-argument", msg),
    }
}

pub fn file_explorer_list_directory(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.listDirectory expects a string sessionId and a string relativePath",
            "fileExplorer.listDirectory rejected an oversized sessionId or path",
        )?;
        let relative_path = require_str(
            &args,
            1,
            MAX_RELATIVE_PATH_LENGTH,
            "fileExplorer.listDirectory expects a string sessionId and a string relativePath",
            "fileExplorer.listDirectory rejected an oversized sessionId or path",
        )?;

        let (worktree_path, repo_path, archived) = session_context(&state, &session_id).await?;
        if archived {
            return Err(IpcError::new(
                "session-archived",
                "This Session is archived",
            ));
        }

        let runtime = tokio::runtime::Handle::current();
        watch_state::ensure_watcher(
            runtime,
            state.app_handle.clone(),
            Some(state.registry.clone()),
            &session_id,
            &worktree_path,
            repo_path.clone(),
            archived,
        );
        let watched_handle = watch_state::watcher_handle(&session_id);

        let result = list_directory_entries(
            &session_id,
            repo_path.as_deref(),
            &worktree_path,
            &relative_path,
        )
        .await;

        if let Err(ListDirectoryError::WorktreeMissing) = &result {
            match &watched_handle {
                Some(handle) if watch_state::watcher_matches(&session_id, handle) => {
                    watch_state::stop_file_explorer_watcher(&session_id);
                    watch_state::notify_file_explorer_reset(&state.app_handle, &session_id);
                }
                None if relative_path.is_empty() && watch_state::has_loaded_paths(&session_id) => {
                    watch_state::notify_file_explorer_reset(&state.app_handle, &session_id);
                }
                _ => {}
            }
        }

        if result.is_ok() {
            let still_live = {
                let registry = state.registry.lock().await;
                registry
                    .get_session(&session_id)
                    .map(|s| s.archived_at.is_none())
                    .unwrap_or(false)
            };
            if still_live {
                watch_state::record_loaded_path(&session_id, &relative_path);
            }
        }

        result
            .map(|ok| json!({ "entries": ok.entries, "truncated": ok.truncated }))
            .map_err(list_directory_error_to_ipc)
    })
}

pub fn file_explorer_stop_watching(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.stopWatching expects a string sessionId",
            "fileExplorer.stopWatching rejected an oversized sessionId",
        )?;
        watch_state::stop_file_explorer_watcher(&session_id);
        Ok(Value::Null)
    })
}

pub fn file_explorer_ensure_watching(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.ensureWatching expects a string sessionId",
            "fileExplorer.ensureWatching rejected an oversized sessionId",
        )?;
        let (worktree_path, repo_path, archived) = session_context(&state, &session_id).await?;
        let runtime = tokio::runtime::Handle::current();
        let had_watcher = watch_state::has_watcher(&session_id);
        watch_state::ensure_watcher(
            runtime.clone(),
            state.app_handle.clone(),
            Some(state.registry.clone()),
            &session_id,
            &worktree_path,
            repo_path.clone(),
            archived,
        );
        let has_watcher_now = watch_state::has_watcher(&session_id);
        if !had_watcher && has_watcher_now {
            watch_state::reflush_loaded_paths(
                runtime,
                state.app_handle.clone(),
                Some(state.registry.clone()),
                &session_id,
                &worktree_path,
                repo_path,
            );
        } else if !has_watcher_now && watch_state::has_loaded_paths(&session_id) {
            if let Err(ResolveReason::WorktreeMissing) =
                resolve_list_target(&session_id, repo_path.as_deref(), &worktree_path, "").await
            {
                watch_state::notify_file_explorer_reset(&state.app_handle, &session_id);
            }
        }
        Ok(Value::Null)
    })
}

pub fn file_explorer_read_preview(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.readPreview expects a string sessionId and a string relativePath",
            "fileExplorer.readPreview rejected an oversized sessionId or path",
        )?;
        let relative_path = require_str(
            &args,
            1,
            MAX_RELATIVE_PATH_LENGTH,
            "fileExplorer.readPreview expects a string sessionId and a string relativePath",
            "fileExplorer.readPreview rejected an oversized sessionId or path",
        )?;
        if relative_path.is_empty() {
            return Err(invalid_argument(
                "fileExplorer.readPreview requires a non-empty relativePath",
            ));
        }
        let (worktree_path, repo_path, _archived) = session_context(&state, &session_id).await?;
        let resolved = resolve_list_target(
            &session_id,
            repo_path.as_deref(),
            &worktree_path,
            &relative_path,
        )
        .await
        .map_err(|r| resolve_error_result(r, "file"))?;
        let preview = read_preview_file(resolved.real_path(), &relative_path).await;
        Ok(json!({ "preview": preview }))
    })
}

pub fn file_explorer_get_status(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.getStatus expects a string sessionId",
            "fileExplorer.getStatus rejected an oversized sessionId",
        )?;
        let (worktree_path, _repo_path, _archived) = session_context(&state, &session_id).await?;
        // `None` is a normal result, never an IPC error; a refused guard reads as `None` too (#1157).
        let status = match crate::fs::worktree_access::read_guard_bounded(&session_id).await {
            Ok(_guard) => read_git_status(&worktree_path).await,
            Err(_) => None,
        };
        Ok(json!({ "status": status }))
    })
}

pub fn file_explorer_open_in_vscode(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.openInVSCode expects a string sessionId and a string relativePath",
            "fileExplorer.openInVSCode rejected an oversized sessionId or path",
        )?;
        let relative_path = require_str(
            &args,
            1,
            MAX_RELATIVE_PATH_LENGTH,
            "fileExplorer.openInVSCode expects a string sessionId and a string relativePath",
            "fileExplorer.openInVSCode rejected an oversized sessionId or path",
        )?;
        let (worktree_path, repo_path, _archived) = session_context(&state, &session_id).await?;
        let resolved = resolve_list_target(
            &session_id,
            repo_path.as_deref(),
            &worktree_path,
            &relative_path,
        )
        .await
        .map_err(|r| resolve_error_result(r, "folder"))?;

        // `None` means VS Code is not installed: a normal state, never an IPC error.
        // Argv array, never a shell string, so `& | ^ %` in a path cannot run a second command.
        let Some(code_exe) = resolve_vscode_executable().await else {
            return Ok(json!({ "opened": false }));
        };

        // Strip ELECTRON_RUN_AS_NODE/NODE_OPTIONS, or VS Code runs its argument as a Node script.
        // stdio is null, and VS Code exits with Refract (job breakaway is still open).
        let mut command = std::process::Command::new(&code_exe);
        command.arg(resolved.real_path());
        command.env_remove("ELECTRON_RUN_AS_NODE");
        command.env_remove("NODE_OPTIONS");
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        match command.spawn() {
            Ok(_child) => Ok(json!({ "opened": true })),
            Err(err) => {
                log::warn!("fileExplorer.openInVSCode: spawn failed: {err}");
                clear_vscode_executable_cache();
                Ok(json!({ "opened": false }))
            }
        }
    })
}

pub fn file_explorer_reveal(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.reveal expects a string sessionId and a string relativePath",
            "fileExplorer.reveal rejected an oversized sessionId or path",
        )?;
        let relative_path = require_str(
            &args,
            1,
            MAX_RELATIVE_PATH_LENGTH,
            "fileExplorer.reveal expects a string sessionId and a string relativePath",
            "fileExplorer.reveal rejected an oversized sessionId or path",
        )?;
        if relative_path.is_empty() {
            return Err(invalid_argument(
                "fileExplorer.reveal requires a non-empty relativePath",
            ));
        }
        let (worktree_path, repo_path, _archived) = session_context(&state, &session_id).await?;
        let resolved = resolve_list_target(
            &session_id,
            repo_path.as_deref(),
            &worktree_path,
            &relative_path,
        )
        .await
        .map_err(|r| resolve_error_result(r, "file"))?;
        // Reveal (show in folder), never an open verb, which would run the file (constitution V).
        let _ = show_item_in_folder(resolved.real_path());
        Ok(Value::Null)
    })
}

pub fn file_explorer_copy_path(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "fileExplorer.copyPath expects a string sessionId and a string relativePath",
            "fileExplorer.copyPath rejected an oversized sessionId or path",
        )?;
        let relative_path = require_str(
            &args,
            1,
            MAX_RELATIVE_PATH_LENGTH,
            "fileExplorer.copyPath expects a string sessionId and a string relativePath",
            "fileExplorer.copyPath rejected an oversized sessionId or path",
        )?;
        if relative_path.is_empty() {
            return Err(invalid_argument(
                "fileExplorer.copyPath requires a non-empty relativePath",
            ));
        }
        let (worktree_path, repo_path, _archived) = session_context(&state, &session_id).await?;
        let resolved = resolve_list_target(
            &session_id,
            repo_path.as_deref(),
            &worktree_path,
            &relative_path,
        )
        .await
        .map_err(|r| resolve_error_result(r, "file"))?;

        let text = resolved.real_path().to_string_lossy().into_owned();
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Err(IpcError::new("clipboard-failed", "No window yet"));
        };
        use tauri_plugin_clipboard_manager::ClipboardExt;
        tokio::task::spawn_blocking(move || app_handle.clipboard().write_text(text))
            .await
            .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))?
            .map_err(|err| IpcError::new("clipboard-failed", err.to_string()))?;
        Ok(Value::Null)
    })
}
