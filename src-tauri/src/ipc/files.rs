// IPC handler for `sessions.revealFile` (issue #610, lane R7 #790): reveals a single file in the
// OS file explorer via Explorer's `/select,` verb -- deliberately NEVER an "open" verb that would
// run the file's own default handler (a `.cmd`/`.ps1`/`.lnk`/`.js` an agent or tool wrote would
// execute), exactly the attack surface constitution V's "agent/tool/file output is untrusted"
// rule exists to close. The path comes straight from rendered chat text (a linkified file
// reference) -- main is the sole authority on containment; the renderer's own string checks are a
// cheap early-out, never trusted here.
//
// Also home to `resolve_error_result`, shared by this file's own handler and
// `ipc::file_explorer`'s handlers: maps a `fs::resolve::ResolveReason` to the same three error
// codes and plain-English messages every caller of `resolve_in_worktree` uses -- never a real
// filesystem path (constitution V: never leak one into a message a screen reader or log could
// surface).

use serde_json::Value;

use crate::fs::resolve::{resolve_in_worktree, ResolveReason};

use super::{arg_str, invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.revealFile", sessions_reveal_file);
}

const MAX_SESSION_ID_LENGTH: usize = 256;
const MAX_TOKEN_LENGTH: usize = 4096;

/// Shared by every caller of `resolve_in_worktree` to map a `ResolveReason` to the same three
/// error codes and messages, `noun` letting each call site say "file" or "folder" without a
/// second, drifting copy of this mapping.
pub fn resolve_error_result(reason: ResolveReason, noun: &str) -> IpcError {
    match reason {
        ResolveReason::WorktreeMissing => IpcError::new(
            "worktree-missing",
            "This Session's worktree folder no longer exists",
        ),
        ResolveReason::FileMissing => IpcError::new(
            "file-missing",
            format!("Couldn't find that {noun} in this Session's worktree"),
        ),
        ResolveReason::OutsideWorktree => IpcError::new(
            "outside-worktree",
            "That path is outside this Session's worktree",
        ),
    }
}

/// Explorer's own `/select,<path>` verb: highlights `path` in its parent folder's Explorer
/// window, never executing it -- the Rust equivalent of `shell.showItemInFolder` (Electron) /
/// `tauri-plugin-opener`'s own `reveal_item_in_dir` is not used here since this build already
/// resolves the fixed `explorer.exe` path itself (`process::executables::explorer_exe_path`,
/// lane R1) for the identical reason `sessions.revealWorktree` does: never spawn a bare name.
pub(super) fn show_item_in_folder(path: &std::path::Path) -> std::io::Result<std::process::Child> {
    let arg = format!("/select,{}", path.display());
    std::process::Command::new(crate::process::executables::explorer_exe_path())
        .arg(arg)
        .spawn()
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
