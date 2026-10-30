// `attachments.readImageFile` channel. Holds its own copy of the path-containment helpers, since
// `files.rs` belongs to another lane (#790) and one file must have one owner (#784).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::fs;
use tokio::io::AsyncReadExt;

use crate::omp::images::{
    base64_encode, read_image_dimensions, sniff_image_mime_type, MAX_IMAGE_INPUT_BYTES,
    MAX_IMAGE_PIXELS,
};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("attachments.readImageFile", attachments_read_image_file);
}

// `pub(super)` so `file_attachments.rs` reuses these instead of duplicating them.
pub(super) const MAX_SESSION_ID_LENGTH: usize = 256;
pub(super) const MAX_TOKEN_LENGTH: usize = 4096;
// Caps link substitutions so a symlink cycle is rejected instead of looping forever.
const MAX_LINK_HOPS: u32 = 32;

/// Windows reserved device names, matched per path segment, including the superscript `COM`/`LPT`
/// variants.
fn is_reserved_name(segment: &str) -> bool {
    let upper = segment.to_ascii_uppercase();
    let core_end = upper.find('.').unwrap_or(upper.len());
    let core = upper[..core_end].trim_end_matches(' ');
    match core {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => core
            .strip_prefix("COM")
            .or_else(|| core.strip_prefix("LPT"))
            .map(|rest| {
                let mut chars = rest.chars();
                matches!(
                    (chars.next(), chars.next()),
                    (Some('1'..='9'), None) | (Some('\u{b9}' | '\u{b2}' | '\u{b3}'), None)
                )
            })
            .unwrap_or(false),
    }
}

/// Rejects unsafe tokens by text alone, before any filesystem call: NUL bytes, UNC/device paths,
/// colons other than a drive prefix, and reserved device names.
fn is_unsafe_token(value: &str) -> bool {
    if value.contains('\0') {
        return true;
    }
    if value.replace('\\', "/").starts_with("//") {
        return true;
    }
    let chars: Vec<char> = value.chars().collect();
    let first_colon = chars.iter().position(|&c| c == ':');
    let drive_prefix = first_colon == Some(1)
        && chars
            .first()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false);
    if let Some(idx) = first_colon {
        if !(idx == 1 && drive_prefix) {
            return true;
        }
    }
    if chars.iter().skip(2).any(|&c| c == ':') {
        return true;
    }
    if drive_prefix {
        match chars.get(2) {
            Some(&c) if c == '/' || c == '\\' => {}
            _ => return true, // drive-relative ("D:foo") or a bare "D:"
        }
    }
    value
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .any(is_reserved_name)
}

/// ASCII-only case fold, Windows only. Non-ASCII is never folded, so this is a pre-filter, not
/// the security boundary.
fn fold_case(value: &str) -> String {
    if cfg!(target_os = "windows") {
        value.chars().map(|c| c.to_ascii_lowercase()).collect()
    } else {
        value.to_string()
    }
}

fn is_contained_in(value: &str, root: &str) -> bool {
    value == root || value.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

/// Collapses `.` and `..` lexically, without touching the filesystem.
fn lexical_normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in p.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Strips the `\\?\` prefix that `canonicalize` adds on Windows, so paths compare like Node's
/// `realpath` output.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path;
    };
    let mut out = match prefix.kind() {
        Prefix::VerbatimDisk(disk) => PathBuf::from(format!("{}:", disk as char)),
        Prefix::VerbatimUNC(server, share) => PathBuf::from(format!(
            r"\\{}\{}",
            server.to_string_lossy(),
            share.to_string_lossy()
        )),
        _ => return path,
    };
    out.extend(components);
    out
}

async fn realpath(p: &Path) -> std::io::Result<PathBuf> {
    fs::canonicalize(p).await.map(strip_verbatim_prefix)
}

enum WalkError {
    FileMissing,
    OutsideWorktree,
}

/// Walks `relative_suffix` one segment at a time, vetting each symlink target before following it.
/// Never hands a multi-segment path to one native resolve, which would skip those checks.
async fn resolve_no_follow(
    root: &Path,
    unresolved_root: &Path,
    relative_suffix: &str,
) -> Result<PathBuf, WalkError> {
    let folded_root = fold_case(&root.to_string_lossy());
    let folded_unresolved_root = fold_case(&unresolved_root.to_string_lossy());

    let mut current = root.to_path_buf();
    let mut queue: Vec<String> = relative_suffix
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let mut hops = 0u32;

    while !queue.is_empty() {
        let segment = queue.remove(0);
        let next = current.join(&segment);
        let lst = match fs::symlink_metadata(&next).await {
            Ok(m) => m,
            Err(_) => return Err(WalkError::FileMissing),
        };
        if !lst.file_type().is_symlink() {
            current = next;
            continue;
        }
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return Err(WalkError::OutsideWorktree);
        }
        let raw_target = match fs::read_link(&next).await {
            Ok(t) => t,
            Err(_) => return Err(WalkError::FileMissing),
        };
        let raw_target_str = raw_target.to_string_lossy().into_owned();
        if is_unsafe_token(&raw_target_str) {
            return Err(WalkError::OutsideWorktree);
        }
        let target_abs = if raw_target.is_absolute() {
            lexical_normalize(&raw_target)
        } else {
            lexical_normalize(&current.join(&raw_target))
        };
        let folded_target = fold_case(&target_abs.to_string_lossy());
        let matched_root = if is_contained_in(&folded_target, &folded_root) {
            Some(root)
        } else if is_contained_in(&folded_target, &folded_unresolved_root) {
            Some(unresolved_root)
        } else {
            None
        };
        let Some(matched_root) = matched_root else {
            return Err(WalkError::OutsideWorktree);
        };
        // Restart from `root`: the target may hold further unverified links in its own segments.
        let rel = target_abs.strip_prefix(matched_root).unwrap_or(&target_abs);
        let mut rest: Vec<String> = rel
            .to_string_lossy()
            .split(['\\', '/'])
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        rest.extend(queue);
        queue = rest;
        current = root.to_path_buf();
    }
    // A link resolving back to the worktree root is rejected, like a token equal to the root.
    if current == root {
        return Err(WalkError::FileMissing);
    }
    Ok(current)
}

/// Like `resolve_no_follow`, for absolute paths with no containment root (#514).
async fn resolve_no_follow_unrooted(absolute_token: &str) -> Option<PathBuf> {
    use std::path::Component;
    let normalized = lexical_normalize(Path::new(absolute_token));
    let mut root = PathBuf::new();
    let mut queue: Vec<String> = Vec::new();
    for component in normalized.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => root.push(component.as_os_str()),
            other => queue.push(other.as_os_str().to_string_lossy().into_owned()),
        }
    }
    let mut current = root;
    let mut hops = 0u32;

    while !queue.is_empty() {
        let segment = queue.remove(0);
        let next = current.join(&segment);
        let lst = fs::symlink_metadata(&next).await.ok()?;
        if !lst.file_type().is_symlink() {
            current = next;
            continue;
        }
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return None;
        }
        let raw_target = fs::read_link(&next).await.ok()?;
        let raw_target_str = raw_target.to_string_lossy().into_owned();
        if is_unsafe_token(&raw_target_str) {
            return None;
        }
        let target_abs = if raw_target.is_absolute() {
            lexical_normalize(&raw_target)
        } else {
            lexical_normalize(&current.join(&raw_target))
        };
        let mut target_root = PathBuf::new();
        let mut target_rest: Vec<String> = Vec::new();
        for component in target_abs.components() {
            match component {
                Component::Prefix(_) | Component::RootDir => {
                    target_root.push(component.as_os_str())
                }
                other => target_rest.push(other.as_os_str().to_string_lossy().into_owned()),
            }
        }
        target_rest.extend(queue);
        queue = target_rest;
        current = target_root;
    }
    Some(current)
}

enum ResolveReason {
    OutsideWorktree,
    FileMissing,
    #[allow(dead_code)] // Mirrors `files.ts`'s own three-reason result; not surfaced by this
    // Kept so the return shape matches the original; this channel always reports `not-found`.
    WorktreeMissing,
}

/// Resolves `token` against `worktree_root` and proves containment. Text checks run first:
/// `canonicalize` on a UNC path can trigger an SMB auth attempt (NTLM leak).
async fn resolve_in_worktree(worktree_root: &str, token: &str) -> Result<PathBuf, ResolveReason> {
    if is_unsafe_token(token) {
        return Err(ResolveReason::OutsideWorktree);
    }

    let resolved_root = match realpath(Path::new(worktree_root)).await {
        Ok(p) => p,
        Err(err) => {
            let missing = matches!(err.kind(), std::io::ErrorKind::NotFound)
                || err.raw_os_error() == Some(3) // ERROR_PATH_NOT_FOUND
                || err.raw_os_error() == Some(267); // ERROR_DIRECTORY
            return Err(if missing {
                ResolveReason::WorktreeMissing
            } else {
                ResolveReason::FileMissing
            });
        }
    };
    let unresolved_root = lexical_normalize(Path::new(worktree_root));

    // An absolute `token` overrides the root; a relative one is normalised against it.
    let candidate = if Path::new(token).is_absolute() {
        lexical_normalize(Path::new(token))
    } else {
        lexical_normalize(&resolved_root.join(token))
    };

    let resolved_root_lower = fold_case(&resolved_root.to_string_lossy());
    let unresolved_root_lower = fold_case(&unresolved_root.to_string_lossy());
    let candidate_lower = fold_case(&candidate.to_string_lossy());

    // Lexical containment check first; `resolve_no_follow` catches links that point out.
    let lexically_contained = is_contained_in(&candidate_lower, &resolved_root_lower)
        || is_contained_in(&candidate_lower, &unresolved_root_lower);
    if !lexically_contained {
        return Err(ResolveReason::OutsideWorktree);
    }
    if candidate_lower == resolved_root_lower || candidate_lower == unresolved_root_lower {
        return Err(ResolveReason::FileMissing);
    }

    let relative_suffix = if is_contained_in(&candidate_lower, &resolved_root_lower) {
        candidate
            .strip_prefix(&resolved_root)
            .unwrap_or(&candidate)
            .to_string_lossy()
            .into_owned()
    } else {
        candidate
            .strip_prefix(&unresolved_root)
            .unwrap_or(&candidate)
            .to_string_lossy()
            .into_owned()
    };

    let walked = resolve_no_follow(&resolved_root, &unresolved_root, &relative_suffix)
        .await
        .map_err(|e| match e {
            WalkError::FileMissing => ResolveReason::FileMissing,
            WalkError::OutsideWorktree => ResolveReason::OutsideWorktree,
        })?;

    // Every link is already substituted, so `canonicalize` only fixes casing and 8.3 names.
    let resolved_target = realpath(&walked)
        .await
        .map_err(|_| ResolveReason::FileMissing)?;

    // The real security boundary. No case folding: both sides are already realpath'd.
    let resolved_target_str = resolved_target.to_string_lossy();
    let resolved_root_str = resolved_root.to_string_lossy();
    let contained = resolved_target_str == resolved_root_str
        || resolved_target_str
            .starts_with(&format!("{resolved_root_str}{}", std::path::MAIN_SEPARATOR));
    if !contained {
        return Err(ResolveReason::OutsideWorktree);
    }

    if fs::metadata(&resolved_target).await.is_err() {
        return Err(ResolveReason::FileMissing);
    }
    Ok(resolved_target)
}

/// Absolute paths are walked with no containment (#514); relative ones go to `resolve_in_worktree`.
pub(super) async fn resolve_attachment_path(worktree_root: &str, token: &str) -> Option<PathBuf> {
    if is_unsafe_token(token) {
        return None;
    }
    if Path::new(token).is_absolute() {
        resolve_no_follow_unrooted(token).await
    } else {
        resolve_in_worktree(worktree_root, token).await.ok()
    }
}

/// Shared session-to-worktree lookup, so each handler does not repeat the registry lock.
pub(super) async fn resolve_session_worktree(
    state: &AppState,
    session_id: &str,
) -> Result<String, IpcError> {
    let registry = state.registry.lock().await;
    match registry.get_session(session_id) {
        Some(session) => Ok(session.worktree_path.clone()),
        None => Err(not_found(format!("Session not found: {session_id}"))),
    }
}

/// Opens the file, then stats and reads through that one handle. Returns `None` if the file is
/// already over `cap`, before any read. Directories must be rejected by the caller first.
pub(super) async fn read_bounded(
    real_path: &Path,
    cap: u64,
) -> Result<(std::fs::Metadata, Option<Vec<u8>>), IpcError> {
    let mut file = match fs::File::open(real_path).await {
        Ok(f) => f,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_found("That file could not be found."))
        }
        Err(_) => return Err(invalid_argument("That file could not be read.")),
    };
    let metadata = file
        .metadata()
        .await
        .map_err(|_| invalid_argument("That file could not be read."))?;
    if metadata.len() > cap {
        return Ok((metadata, None));
    }
    let read_cap = (metadata.len() + 1) as usize;
    let mut buffer = vec![0u8; read_cap];
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
            Err(_) => return Err(invalid_argument("That file could not be read.")),
        }
    }
    buffer.truncate(bytes_read);
    Ok((metadata, Some(buffer)))
}

/// Reads a validated image. Returns only the bytes, never the resolved path or other metadata.
async fn read_image_file(worktree_root: &str, token: &str) -> Result<Value, IpcError> {
    let Some(real_path) = resolve_attachment_path(worktree_root, token).await else {
        return Err(not_found("That file could not be found."));
    };
    let (metadata, buffer) = read_bounded(&real_path, MAX_IMAGE_INPUT_BYTES).await?;
    if !metadata.is_file() {
        return Err(not_found("That file could not be found."));
    }
    // Size is checked before decoding, so an oversized file is refused without a read.
    let Some(buffer) = buffer else {
        return Err(IpcError::new(
            "image-too-large",
            format!(
                "Image is too large to attach (over the {} MiB limit); nothing was attached.",
                MAX_IMAGE_INPUT_BYTES / (1024 * 1024)
            ),
        ));
    };
    // A file that grew after the stat is refused, not trusted.
    if buffer.len() as u64 > metadata.len() {
        return Err(not_found("That file could not be read."));
    }

    // Type is detected from content, never from the extension.
    let header_len = buffer.len().min(24);
    let Some(mime_type) = sniff_image_mime_type(&buffer[..header_len]) else {
        return Err(IpcError::new(
            "unsupported-image-type",
            "That file is not a supported image type; nothing was attached.",
        ));
    };
    // Decompression-bomb guard: a missing or malformed dimension header is refused.
    let Some((width, height)) = read_image_dimensions(&buffer, mime_type) else {
        return Err(IpcError::new(
            "unsupported-image-type",
            "That file could not be read as an image; nothing was attached.",
        ));
    };
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return Err(IpcError::new(
            "image-too-large",
            "Image exceeds the maximum pixel count; nothing was attached.",
        ));
    }

    Ok(json!({
        "mimeType": mime_type,
        "base64": base64_encode(&buffer),
        "byteLength": buffer.len(),
    }))
}

pub fn attachments_read_image_file(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.readImageFile expects a string sessionId and a string path",
            ));
        };
        let Some(token) = args.get(1).and_then(Value::as_str) else {
            return Err(invalid_argument(
                "attachments.readImageFile expects a string sessionId and a string path",
            ));
        };
        if session_id.len() > MAX_SESSION_ID_LENGTH || token.len() > MAX_TOKEN_LENGTH {
            return Err(invalid_argument(
                "attachments.readImageFile rejected an oversized sessionId or path",
            ));
        }
        let worktree_root = resolve_session_worktree(&state, session_id).await?;
        read_image_file(&worktree_root, token).await
    })
}

#[cfg(test)]
#[path = "attachments.test.rs"]
mod tests;
