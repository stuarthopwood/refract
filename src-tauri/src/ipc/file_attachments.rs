// #926: "attach any file type, inlining text files up to 256 KB and sending other files as a
// path" -- the file-path sibling of `attachments.rs`'s own image-path reader, split into its own
// module (not grown into `attachments.rs` itself) per issue #806's "one agent per Rust file"/
// file-size convention: `ipc/attachments.rs` already sat near its own soft cap before this
// feature. Reuses `attachments.rs`'s own `resolve_attachment_path`/`read_bounded`/
// `resolve_session_worktree`/shared length constants (gate round 1, Code1 Medium: DRY) rather
// than a second, independent copy of any of them.

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
    // #926: "attach any file type" -- `readFile` classifies a non-image path (inline text up to
    // the cap, or sent as its own path when binary/oversized/a folder); `pickFiles` is the
    // Attach button's native multi-file dialog (real OS paths, no extension filter), the same
    // pattern `repositories.pickFolder` already uses. `recordDroppedPaths` is the native-OS-drop
    // half of the same allow-list `pickFiles` populates (D2, see below).
    d.register("attachments.readFile", attachments_read_file);
    d.register("attachments.pickFiles", attachments_pick_files);
    d.register(
        "attachments.recordDroppedPaths",
        attachments_record_dropped_paths,
    );
}

// #926 (Stuart's own grill decision 2/3): a text file up to this many bytes is inlined verbatim;
// anything larger is sent as its own path instead. Fixed, not a Setting (grill decision 3).
const MAX_INLINE_FILE_BYTES: u64 = 256 * 1024;
// #926 (grill decision 3): "binary" means a NUL byte anywhere in this many leading bytes, or the
// whole read not being valid UTF-8 -- checked against the SAME bytes already read for the cap
// above, never a second read.
const BINARY_SNIFF_PREFIX_BYTES: usize = 8 * 1024;
// Gate round 1 (D2 Medium): caps how many absolute paths one Session's own allow-list below will
// ever hold -- an unbounded set would otherwise grow forever across a long-lived Session's many
// picks/drops. Gate round 2 (D2-rev, Sec2 Medium): hitting the cap is now a surfaced error, never
// a silent "the rest just didn't get recorded" -- a Session that picks/drops this many distinct
// absolute paths in one run is far outside normal use, worth telling the developer about.
const MAX_ALLOWED_PATHS_PER_SESSION: usize = 500;

/// D2 (decided, gate round 2 correction): the per-session set of absolute paths the RENDERER has
/// itself already resolved via `attachments.pickFiles`'s own native dialog or a native OS
/// drag-drop (`attachments.recordDroppedPaths`, called by `useTauriFileDrop.ts` before it ever
/// attaches anything). `read_file_attachment` below refuses any OTHER absolute token outright.
/// This stops a CONFUSED renderer from reading an arbitrary absolute path it was never actually
/// shown by the user (a stale/incorrect in-memory path, a logic bug) -- it is not a defence
/// against a COMPROMISED renderer, which already has equivalent reach through this app's own
/// agent (file read/write tools run with the developer's own full filesystem access; CSP's
/// `script-src 'self'` with no remote content already bounds what a compromised renderer could
/// even load). A RELATIVE token is unaffected: it still goes through the existing
/// worktree-contained resolver untouched. Process-wide (not persisted): a restart clears every
/// Session's own allow-list, which is fine -- a fresh picker/drop always re-populates it before
/// `readFile` is ever called for that path. `forget_session` below drops a Session's own entry
/// entirely once it is deleted (`sessions_lifecycle.rs`'s own `sessions_delete`), so this map
/// never grows by one stale entry per Session ever created and later removed.
static ALLOWED_PATHS_STORE: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn allowed_paths_store() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    &ALLOWED_PATHS_STORE
}

/// Gate round 2 (D2-rev Sec2 Medium): returns `false` once the cap is reached so the caller can
/// surface a real error instead of silently dropping the overflow paths on the floor.
fn record_allowed_paths(session_id: &str, paths: impl IntoIterator<Item = String>) -> bool {
    let mut store = allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned");
    let set = store.entry(session_id.to_string()).or_default();
    let mut all_recorded = true;
    for path in paths {
        if set.len() >= MAX_ALLOWED_PATHS_PER_SESSION {
            all_recorded = false;
            continue;
        }
        set.insert(path);
    }
    all_recorded
}

fn is_allowed_absolute_path(session_id: &str, path: &str) -> bool {
    allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned")
        .get(session_id)
        .is_some_and(|set| set.contains(path))
}

/// Gate round 2 (D2-rev Sec2 Medium): drops `session_id`'s own allow-list entry entirely --
/// called from `sessions_lifecycle.rs`'s `sessions_delete` once a Session is actually gone, so
/// this process-wide map never accumulates one stale entry per Session ever created.
pub(crate) fn forget_session(session_id: &str) {
    allowed_paths_store()
        .lock()
        .expect("allowed_paths_store poisoned")
        .remove(session_id);
}

/// #926: classifies ANY resolvable non-image path (file or folder) for the "attach any file"
/// feature. Unlike `attachments.rs`'s own `read_image_file`, this DOES return the resolved,
/// symlink-vetted absolute path to the renderer -- the whole point of a "sent as path" attachment
/// is that the agent reads the file itself with its own tools, so the real path IS the payload
/// for that case, not a privacy leak (#926's own "added to the message as its absolute path"
/// decision). A directory classifies the same way a too-large/binary file does -- #926's own
/// "folders are sent as a path" decision -- with `isDirectory: true` and no meaningful byte count.
async fn read_file_attachment(
    session_id: &str,
    worktree_root: &str,
    token: &str,
) -> Result<Value, IpcError> {
    // D2 (decided): an ABSOLUTE token must already be on this Session's own allow-list (recorded
    // by `pickFiles`/`recordDroppedPaths`); a RELATIVE token is unaffected, still fully handled
    // by `resolve_attachment_path`'s own worktree-contained branch below.
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

    // Gate round 2 (Code2 HIGH): a directory is classified via its own path-based stat BEFORE
    // `read_bounded` ever runs -- `File::open` on a directory fails outright on Windows (no
    // `FILE_FLAG_BACKUP_SEMANTICS`), so a folder could never reach `read_bounded`'s own
    // open-handle metadata at all; round 1's `is_dir()` branch inside that shared helper was
    // unreachable dead code for exactly this reason, now removed there.
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

    // Gate round 2 (Code2 HIGH): `read_bounded` now checks the real on-disk size BEFORE ever
    // reading a byte -- `None` means already proven over the inline cap from the stat alone.
    let (metadata, buffer) = read_bounded(&real_path, MAX_INLINE_FILE_BYTES).await?;
    if !metadata.is_file() {
        return Err(not_found("That file could not be found."));
    }
    let Some(buffer) = buffer else {
        // #926 grill decision 2/3: over the inline cap -- sent as its own path. Gate round 2
        // (Code2 HIGH): the REAL on-disk size from the stat, never a buffer length (which would
        // always read back as exactly the inline cap regardless of how much larger the file
        // actually is).
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": metadata.len(),
            "isDirectory": false,
        }));
    };
    if buffer.len() as u64 > metadata.len() {
        // Gate round 2 (Code2 HIGH): grew past its OWN stat'd size mid-read (compared against
        // `metadata.len()` itself, never the external cap, which a slight growth would never
        // trip) -- sent as a path, same as any other over-cap file, never truncated and inlined
        // as if it were the whole file.
        return Ok(json!({
            "kind": "path",
            "path": path_string,
            "name": name,
            "byteLength": buffer.len(),
            "isDirectory": false,
        }));
    }

    // #926 grill decision 3: "binary" means a NUL byte in the first `BINARY_SNIFF_PREFIX_BYTES`,
    // or the whole read not being valid UTF-8 -- checked against these SAME already-read bytes,
    // never a second read of the file.
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
    // `buffer` moves into `from_utf8` instead of being cloned first -- its own byte length is
    // captured beforehand since `String::from_utf8`'s `Err` arm returns the original bytes back
    // out (`FromUtf8Error::into_bytes`), not a borrow, so there is no later read of `buffer` to
    // preserve by cloning.
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

/// #926: native multi-file picker for the composer's Attach button -- real absolute OS paths
/// (never a browser `File` with no path, same reasoning `repositories.pickFolder` already
/// relies on), routed through `attachments.readImageFile`/`.readFile` by the renderer exactly
/// like a dropped path. No extension filter: "any file type" is the point of this feature.
/// D2: now also the FIRST half of `readFile`'s own absolute-path allow-list -- every path this
/// dialog returns is recorded against the calling Session before it is handed back to the
/// renderer. Gate round 2 (D2-rev Sec2 Medium): validates the Session exists FIRST
/// (`resolve_session_worktree`), so this map never gains a key for a Session id that was never
/// real, and surfaces a named error if the per-session cap was hit instead of silently dropping
/// the overflow.
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
        let files = tokio::task::spawn_blocking(move || {
            app_handle.dialog().file().blocking_pick_files()
        })
        .await
        .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let path_strings: Vec<String> = files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !record_allowed_paths(&session_id, path_strings.iter().cloned()) {
            return Err(invalid_argument(
                "Too many files picked in this Session already; some of this pick could not be recorded. Try fewer at once.",
            ));
        }
        Ok(Value::Array(path_strings.into_iter().map(Value::String).collect()))
    })
}

/// D2: the native-OS-drag-drop half of `readFile`'s own absolute-path allow-list above --
/// `useTauriFileDrop.ts`'s own `onFileDrop` handler calls this BEFORE attaching anything,
/// recording the exact paths Tauri's own native drag-drop handler just reported, the same way
/// `pickFiles`'s own paths already are. Gate round 2 (D2-rev Sec2 Medium): recording happens
/// HERE, in Rust, rather than trusting the renderer's own event payload alone -- the native
/// drop event and the renderer's own `onFileDrop` callback both originate from the SAME Tauri
/// event, so recording in Rust closes no real race the renderer-side event couldn't also close,
/// but keeps the allow-list's only writer on this side of the boundary, consistent with
/// `pickFiles`. Session existence is validated first, same as `pickFiles`.
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
                "Too many files dropped in this Session already; some of this drop could not be recorded. Try fewer at once.",
            ));
        }
        Ok(Value::Bool(true))
    })
}
