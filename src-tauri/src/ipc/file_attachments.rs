// File-path sibling of `attachments.rs`'s image reader. Reuses its shared path and read helpers.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};
use tokio::fs;

use tauri_plugin_dialog::DialogExt;

use super::attachments::{
    read_bounded, resolve_attachment_path, resolve_session_worktree, MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
};
use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    // `readFile` inlines text up to the cap; `pickFiles` is the native multi-file dialog.
    d.register("attachments.readFile", attachments_read_file);
    d.register("attachments.pickFiles", attachments_pick_files);
    d.register(
        "attachments.recordDroppedPaths",
        attachments_record_dropped_paths,
    );
}

// Text files up to this size are inlined. Larger files are sent as a path.
const MAX_INLINE_FILE_BYTES: u64 = 256 * 1024;
// "Binary" means a NUL byte in the sniffed prefix or invalid UTF-8 in the whole read.
const BINARY_SNIFF_PREFIX_BYTES: usize = 8 * 1024;
// Caps the allow-list size. Hitting the cap is a surfaced error, never a silent drop.
const MAX_ALLOWED_PATHS_PER_SESSION: usize = 500;

/// Per-session absolute paths the renderer picked or dropped. Process-wide, not persisted.
/// `read_file_attachment` refuses any other absolute token.
static ALLOWED_PATHS_STORE: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn allowed_paths_store() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    &ALLOWED_PATHS_STORE
}

/// Records paths for a session. Returns `false` when the cap is hit. Duplicates are skipped.
/// All-or-nothing: a partial insert would leave some paths allow-listed despite an error.
fn record_allowed_paths(session_id: &str, paths: impl IntoIterator<Item = String>) -> bool {
    let mut store = allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned");
    let set = store.entry(session_id.to_string()).or_default();
    // A `HashSet` keeps the membership checks O(1) for large batches.
    let mut new_paths: HashSet<String> = HashSet::new();
    for path in paths {
        if !set.contains(&path) {
            new_paths.insert(path);
        }
    }
    if set.len() + new_paths.len() > MAX_ALLOWED_PATHS_PER_SESSION {
        return false;
    }
    set.extend(new_paths);
    true
}

fn is_allowed_absolute_path(session_id: &str, path: &str) -> bool {
    allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned")
        .get(session_id)
        .is_some_and(|set| set.contains(path))
}

/// Drops a session's allow-list entry when the session is deleted, so the map does not grow.
pub(crate) fn forget_session(session_id: &str) {
    allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned")
        .remove(session_id);
}

/// Classifies a resolvable path as text, binary, oversized, or folder. Returns the real path,
/// since a path-sent attachment is read by the agent itself.
async fn read_file_attachment(
    session_id: &str,
    worktree_root: &str,
    token: &str,
) -> Result<Value, IpcError> {
    // An absolute token must already be on this session's allow-list. A relative one is not.
    if Path::new(token).is_absolute() && !is_allowed_absolute_path(session_id, token) {
        return Err(not_found("That file could not be found."));
    }
    let Some(real_path) = resolve_attachment_path(worktree_root, token).await else {
        return Err(not_found("That file could not be found."));
    };
    let name = real_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| real_path.to_string_lossy().into_owned());
    let path_string = real_path.to_string_lossy().into_owned();

    // Folders are classified by a path stat first, since `File::open` fails on a directory.
    let path_metadata = fs::metadata(&real_path)
        .await
        .map_err(|_| not_found("That file could not be found."))?;
    if path_metadata.is_dir() {
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": 0,
            "isDirectory": true,
        }));
    }

    // `read_bounded` returns `None` when the stat alone proves the file is over the cap.
    let (metadata, buffer) = read_bounded(&real_path, MAX_INLINE_FILE_BYTES).await?;
    if !metadata.is_file() {
        return Err(not_found("That file could not be found."));
    }
    let Some(buffer) = buffer else {
        // Over the inline cap. Reports the real on-disk size from the stat.
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": metadata.len(),
            "isDirectory": false,
        }));
    };
    if buffer.len() as u64 > metadata.len() {
        // Grew past its stat'd size mid-read. Reports the stat'd size, not the buffer length.
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": metadata.len(),
            "isDirectory": false,
        }));
    }

    // Binary means a NUL byte in the sniffed prefix or invalid UTF-8. Checks the bytes already read.
    let sniff_len = buffer.len().min(BINARY_SNIFF_PREFIX_BYTES);
    if buffer[..sniff_len].contains(&0u8) {
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": buffer.len(),
            "isDirectory": false,
        }));
    }
    // The byte length is captured first, because `from_utf8` consumes the buffer on error.
    let byte_length = buffer.len();
    match String::from_utf8(buffer) {
        Ok(text) => Ok(json!({
            "kind": "inline",
            "path": path_string,
            "name": name,
            "byteLength": byte_length,
            "text": text,
        })),
        Err(_) => Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": byte_length,
            "isDirectory": false,
        })),
    }
}

pub fn attachments_read_file(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.readFile expects a string sessionId and a string path",
            ));
        };
        let Some(token) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.readFile expects a string sessionId and a string path",
            ));
        };
        if session_id.len() > MAX_SESSION_ID_LENGTH || token.len() > MAX_TOKEN_LENGTH {
            return Err(invalid_argument(
                "attachments.readFile rejected an oversized sessionId or path",
            ));
        }
        let worktree_root = resolve_session_worktree(&state, session_id).await?;
        read_file_attachment(session_id, &worktree_root, token).await
    })
}

/// Native multi-file picker for the Attach button. Returns real OS paths and records them
/// against the session's allow-list. Validates the session again after the dialog closes.
pub fn attachments_pick_files(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.pickFiles expects a string sessionId",
            ));
        };
        if session_id.len() > MAX_SESSION_ID_LENGTH {
            return Err(invalid_argument(
                "attachments.pickFiles rejected an oversized sessionId",
            ));
        }
        resolve_session_worktree(&state, session_id).await?;
        let session_id = session_id.to_string();
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Ok(Value::Array(vec![]));
        };
        let files =
            tokio::task::spawn_blocking(move || app_handle.dialog().file().blocking_pick_files())
                .await
                .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let path_strings: Vec<String> = files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        // The dialog can stay open a long time, so the session is checked again here.
        resolve_session_worktree(&state, &session_id).await?;
        if !record_allowed_paths(&session_id, path_strings.iter().cloned()) {
            return Err(invalid_argument(
                "Too many files picked in this Session already; nothing from this pick was recorded. Try fewer at once.",
            ));
        }
        Ok(Value::Array(
            path_strings.into_iter().map(Value::String).collect(),
        ))
    })
}

/// Records paths from a native OS drag-drop. The renderer calls this before attaching anything.
/// Session existence is validated first, same as `pickFiles`.
pub fn attachments_record_dropped_paths(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.recordDroppedPaths expects a string sessionId and a string[] of paths",
            ));
        };
        if session_id.len() > MAX_SESSION_ID_LENGTH {
            return Err(invalid_argument(
                "attachments.recordDroppedPaths rejected an oversized sessionId",
            ));
        }
        let Some(paths) = args.get(1).and_then(Value::as_array) else {
            return Err(invalid_argument(
                "attachments.recordDroppedPaths expects a string sessionId and a string[] of paths",
            ));
        };
        resolve_session_worktree(&state, session_id).await?;
        let path_strings: Vec<String> = paths
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| s.len() <= MAX_TOKEN_LENGTH)
            .map(String::from)
            .collect();
        if !record_allowed_paths(session_id, path_strings) {
            return Err(invalid_argument(
                "Too many files dropped in this Session already; nothing from this drop was recorded. Try fewer at once.",
            ));
        }
        Ok(Value::Bool(true))
    })
}
