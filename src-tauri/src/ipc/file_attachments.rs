// #926: "attach any file type, inlining text files up to 256 KB and sending other files as a
// path" -- the file-path sibling of `attachments.rs`'s own image-path reader, split into its own
// module (not grown into `attachments.rs` itself) per issue #806's "one agent per Rust file"/
// file-size convention: `ipc/attachments.rs` already sat near its own soft cap before this
// feature. Reuses `attachments.rs`'s own `resolve_attachment_path` (made `pub(super)` for this
// one sibling import) rather than a second, independent copy of the containment/symlink-safety
// walk.

use serde_json::{json, Value};
use tokio::fs;
use tokio::io::AsyncReadExt;

use tauri_plugin_dialog::DialogExt;

use super::attachments::resolve_attachment_path;
use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    // #926: "attach any file type" -- `readFile` classifies a non-image path (inline text up to
    // the cap, or sent as its own path when binary/oversized/a folder); `pickFiles` is the
    // Attach button's native multi-file dialog (real OS paths, no extension filter), the same
    // pattern `repositories.pickFolder` already uses.
    d.register("attachments.readFile", attachments_read_file);
    d.register("attachments.pickFiles", attachments_pick_files);
}

const MAX_SESSION_ID_LENGTH: usize = 256;
// Matches `attachments.rs`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt).
const MAX_TOKEN_LENGTH: usize = 4096;

// #926 (Stuart's own grill decision 2/3): a text file up to this many bytes is inlined verbatim;
// anything larger is sent as its own path instead. Fixed, not a Setting (grill decision 3).
const MAX_INLINE_FILE_BYTES: u64 = 256 * 1024;
// #926 (grill decision 3): "binary" means a NUL byte anywhere in this many leading bytes, or the
// whole read not being valid UTF-8 -- checked against the SAME bytes already read for the cap
// above, never a second read.
const BINARY_SNIFF_PREFIX_BYTES: usize = 8 * 1024;

/// #926: classifies ANY resolvable non-image path (file or folder) for the "attach any file"
/// feature. Unlike `attachments.rs`'s own `read_image_file`, this DOES return the resolved,
/// symlink-vetted absolute path to the renderer -- the whole point of a "sent as path" attachment
/// is that the agent reads the file itself with its own tools, so the real path IS the payload
/// for that case, not a privacy leak (#926's own "added to the message as its absolute path"
/// decision). A directory classifies the same way a too-large/binary file does -- #926's own
/// "folders are sent as a path" decision -- with `isDirectory: true` and no meaningful byte count.
async fn read_file_attachment(worktree_root: &str, token: &str) -> Result<Value, IpcError> {
    let Some(real_path) = resolve_attachment_path(worktree_root, token).await else {
        return Err(not_found("That file could not be found."));
    };
    let name = real_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| real_path.to_string_lossy().into_owned());
    let path_string = real_path.to_string_lossy().into_owned();

    // `real_path` is already fully resolved (no symlinks left, see `resolve_attachment_path`'s
    // own doc comment) -- a plain `fs::metadata` is safe here, no second symlink-follow risk.
    let metadata = match fs::metadata(&real_path).await {
        Ok(m) => m,
        Err(_) => return Err(not_found("That file could not be found.")),
    };
    if metadata.is_dir() {
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": 0,
            "isDirectory": true,
        }));
    }
    if !metadata.is_file() {
        return Err(not_found("That file could not be found."));
    }

    // #926 grill decision 2/3: anything over the inline cap is sent as its own path -- never
    // read past this point, so an oversized file costs one `stat`, not a bounded read.
    if metadata.len() > MAX_INLINE_FILE_BYTES {
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": metadata.len(),
            "isDirectory": false,
        }));
    }

    let mut file = match fs::File::open(&real_path).await {
        Ok(f) => f,
        Err(_) => return Err(not_found("That file could not be read.")),
    };
    // Same open-handle/bounded-read/grew-mid-read guard `attachments.rs`'s own `read_image_file`
    // uses: sized from the real on-disk size (capped at the inline limit), `+ 1` so a file that
    // grows past the cap between the stat above and this read is caught below rather than
    // silently truncated.
    let cap = (metadata.len().min(MAX_INLINE_FILE_BYTES) + 1) as usize;
    let mut buffer = vec![0u8; cap];
    let mut bytes_read = 0usize;
    loop {
        match file.read(&mut buffer[bytes_read..]).await {
            Ok(0) => break,
            Ok(n) => {
                bytes_read += n;
                if bytes_read >= buffer.len() {
                    break;
                }
            }
            Err(_) => return Err(not_found("That file could not be read.")),
        }
    }
    buffer.truncate(bytes_read);
    if bytes_read as u64 > MAX_INLINE_FILE_BYTES {
        // Grew past the cap between the stat and this read -- sent as a path, same as any other
        // over-cap file, never truncated and inlined as if it were the whole file.
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": bytes_read,
            "isDirectory": false,
        }));
    }

    // #926 grill decision 3: "binary" means a NUL byte in the first `BINARY_SNIFF_PREFIX_BYTES`,
    // or the whole read not being valid UTF-8 -- checked against these SAME already-read bytes,
    // never a second read of the file.
    let sniff_len = buffer.len().min(BINARY_SNIFF_PREFIX_BYTES);
    let has_early_nul = buffer[..sniff_len].contains(&0u8);
    let text = if has_early_nul { None } else { String::from_utf8(buffer.clone()).ok() };
    match text {
        Some(text) => Ok(json!({
            "kind": "inline",
            "path": path_string,
            "name": name,
            "byteLength": buffer.len(),
            "text": text,
        })),
        None => Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": buffer.len(),
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
        let worktree_root = {
            let registry = state.registry.lock().await;
            match registry.get_session(session_id) {
                Some(session) => session.worktree_path.clone(),
                None => return Err(not_found(format!("Session not found: {session_id}"))),
            }
        };
        read_file_attachment(&worktree_root, token).await
    })
}

/// #926: native multi-file picker for the composer's Attach button -- real absolute OS paths
/// (never a browser `File` with no path, same reasoning `repositories.pickFolder` already
/// relies on), routed through `attachments.readImageFile`/`.readFile` by the renderer exactly
/// like a dropped path. No extension filter: "any file type" is the point of this feature.
pub fn attachments_pick_files(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let app_handle = state
            .app_handle
            .lock()
            .expect("app_handle mutex poisoned")
            .clone();
        let Some(app_handle) = app_handle else {
            return Ok(Value::Array(vec![]));
        };
        let files = tokio::task::spawn_blocking(move || {
            app_handle.dialog().file().blocking_pick_files()
        })
        .await
        .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let paths: Vec<Value> = files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| Value::String(p.to_string_lossy().into_owned()))
            .collect();
        Ok(Value::Array(paths))
    })
}
