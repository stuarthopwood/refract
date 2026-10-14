// IPC handlers for `fileExplorer.*` (lane R7, issue #790): `listDirectory` (tree browsing),
// `readPreview`/`getStatus` (the preview pane and git status marks), `openInVSCode`/`reveal`/
// `copyPath` (the row actions), `stopWatching`/`ensureWatching` (the watcher lifecycle a mounted
// `FileExplorerPanel` drives). The per-session watcher/loaded-path bookkeeping lives in
// `fs::explorer_watch_state` (same lane, split out to stay under the 600-line soft cap); this
// file is the thin IPC-shaped wiring over it.

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
/// Matches `files.rs`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt) -- kept
/// independent rather than importing that one, the two call sites have no reason to be forced to
/// change together.
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

/// Looks up a Session's worktree path, its repository's path (for issue #729's
/// `worktree_is_valid` check, `None` if the repository itself was removed), and whether it is
/// archived. `Err(not_found)` only when the Session itself no longer exists.
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
            "worktree-missing",
            "This Session's worktree folder no longer exists",
        ),
        ListDirectoryError::FileMissing(msg) => IpcError::new("file-missing", msg),
        ListDirectoryError::OutsideWorktree => IpcError::new(
            "outside-worktree",
            "That path is outside this Session's worktree",
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
            &session_id,
            &worktree_path,
            repo_path.clone(),
            archived,
        );
        let watched_handle = watch_state::watcher_handle(&session_id);

        let result =
            list_directory_entries(repo_path.as_deref(), &worktree_path, &relative_path).await;

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
                &session_id,
                &worktree_path,
                repo_path,
            );
        } else if !has_watcher_now && watch_state::has_loaded_paths(&session_id) {
            if let Err(ResolveReason::WorktreeMissing) =
                resolve_list_target(repo_path.as_deref(), &worktree_path, "").await
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
        let resolved = resolve_list_target(repo_path.as_deref(), &worktree_path, &relative_path)
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
        // `read_git_status` never throws (matches `diff_stat.rs`'s own never-throw convention):
        // `None` is itself a normal, successful result, not an IPC error.
        let status = read_git_status(&worktree_path).await;
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
        let resolved = resolve_list_target(repo_path.as_deref(), &worktree_path, &relative_path)
            .await
            .map_err(|r| resolve_error_result(r, "folder"))?;

        // Research decision (fixed-install-root resolver, never a bare `code`/PATH search):
        // `None` is a normal, expected state (VS Code not installed), never an IPC error.
        let Some(code_exe) = resolve_vscode_executable().await else {
            return Ok(json!({ "opened": false }));
        };

        // `shell: false` equivalent (the default): an argv array, never a shell-interpolated
        // command string, so a path containing `& | ^ %` cannot be read as a second command.
        // `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` stripped from the child's env: VS Code itself
        // embeds an Electron/Node runtime, and an inherited `ELECTRON_RUN_AS_NODE=1` would make
        // it try to run its first argument as a Node script instead of opening it as a file.
        // Known follow-up (recorded in the PR, not silently dropped): this build's own process
        // Job Object (`process::job_object`, another lane's file) joins Refract's process to a
        // kill-on-close job with no breakaway permission, so a spawned VS Code is a job-object
        // descendant and will be closed alongside Refract -- the Electron original's
        // `detached: true` assumed no such ancestor job existed. Changing the job's own
        // breakaway policy is out of this lane's scope (another lane's file).
        let mut command = std::process::Command::new(&code_exe);
        command.arg(resolved.real_path());
        command.env_remove("ELECTRON_RUN_AS_NODE");
        command.env_remove("NODE_OPTIONS");
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
        let resolved = resolve_list_target(repo_path.as_deref(), &worktree_path, &relative_path)
            .await
            .map_err(|r| resolve_error_result(r, "file"))?;
        // Deliberately the "show item in folder" verb, never an "open" verb that would run the
        // file's own default handler (constitution V: agent/tool/file output is untrusted).
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
        let resolved = resolve_list_target(repo_path.as_deref(), &worktree_path, &relative_path)
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
