// `sessions.revealFile` selects the file via the shell API, never an "open" verb that would run it.
// The shell API avoids `explorer.exe /select,`, where a comma splits into a second argument.

use serde_json::Value;

use crate::fs::resolve::{
    resolve_in_worktree, resolve_reason_code, resolve_reason_message, ResolveReason,
};

use super::{arg_str, invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.revealFile", sessions_reveal_file);
}

const MAX_SESSION_ID_LENGTH: usize = 256;
const MAX_TOKEN_LENGTH: usize = 4096;

/// Maps a `ResolveReason` to the shared error code and message; `noun` is "file" or "folder".
pub fn resolve_error_result(reason: ResolveReason, noun: &str) -> IpcError {
    IpcError::new(
        resolve_reason_code(reason),
        resolve_reason_message(reason, noun),
    )
}

/// Reveals `path` in its parent folder via the shell API, never executing it.
pub(super) fn show_item_in_folder(
    path: &std::path::Path,
) -> Result<(), tauri_plugin_opener::Error> {
    tauri_plugin_opener::reveal_item_in_dir(path)
}

pub fn sessions_reveal_file(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = match arg_str(&args, 0) {
            Some(id) if id.len() <= MAX_SESSION_ID_LENGTH => id.to_string(),
            Some(_) => {
                return Err(invalid_argument(
                    "sessions.revealFile rejected an oversized sessionId or path",
                ))
            }
            None => {
                return Err(invalid_argument(
                    "sessions.revealFile expects a string sessionId and a string path",
                ))
            }
        };
        let token = match arg_str(&args, 1) {
            Some(t) if t.len() <= MAX_TOKEN_LENGTH => t.to_string(),
            Some(_) => {
                return Err(invalid_argument(
                    "sessions.revealFile rejected an oversized sessionId or path",
                ))
            }
            None => {
                return Err(invalid_argument(
                    "sessions.revealFile expects a string sessionId and a string path",
                ))
            }
        };

        let worktree_path = {
            let registry = state.registry.lock().await;
            match registry.get_session(&session_id) {
                Some(session) => session.worktree_path.clone(),
                None => return Err(not_found(format!("Session not found: {session_id}"))),
            }
        };

        let resolved = resolve_in_worktree(std::path::Path::new(&worktree_path), &token)
            .await
            .map_err(|reason| resolve_error_result(reason, "file"))?;

        // Never logs the resolved path itself.
        let _ = show_item_in_folder(&resolved);
        Ok(Value::Null)
    })
}
