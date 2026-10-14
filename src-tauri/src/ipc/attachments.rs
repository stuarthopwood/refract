// Chat attachment IPC channels (lane R4, issue #787): `attachments.readImageFile`, the file-path
// sibling of `ipc/chat.rs`'s own base64/clipboard image path. Port of `src/main/ipc/attachments.ts`
// (the shared reader #514/#432 built) plus the containment/symlink-safety primitives
// `src/main/ipc/files.ts` provides it (`isUnsafeToken`, `resolveNoFollow`,
// `resolveNoFollowUnrooted`, `resolveInWorktree`) -- ported HERE rather than into `ipc/files.rs`
// (lane R7's own pre-declared file, issue #790): issue #784's "one agent per Rust file" rule
// means a file can have only one owning lane, and `files.rs` is R7's. The Electron build shares
// one copy because `attachments.ts` already imports from `files.ts` there; this build accepts
// the duplication (a second, independent copy will exist once R7 lands `files.rs`) as the cost
// of never needing cross-lane coordination over either file.

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

const MAX_SESSION_ID_LENGTH: usize = 256;
// Matches `files.ts`'s own `MAX_TOKEN_LENGTH` (a single path, not a whole prompt).
const MAX_TOKEN_LENGTH: usize = 4096;
// Bounds how many link substitutions the walk below will follow before rejecting outright --
// without this, a cycle (`a -> b`, `b -> a`) would loop forever.
const MAX_LINK_HOPS: u32 = 32;

/// Windows reserved device names (case-insensitive, with or without a trailing extension) --
/// rejected as a path SEGMENT anywhere in the token, before any filesystem call ever touches it.
/// Defence in depth, not the only thing standing between a reserved name and `fs::open` (every
/// one of these fails `fs::canonicalize` with not-found in practice). Simplified from `files.ts`'s
/// own regex (no superscript-digit `COM`/`LPT` variants, no embedded-dot-run edge cases): still
/// catches the real shapes an attacker or a careless tool would actually produce.
fn is_reserved_name(segment: &str) -> bool {
    let upper = segment.to_ascii_uppercase();
    let core_end = upper.find('.').unwrap_or(upper.len());
    let core = upper[..core_end].trim_end_matches(' ');
    match core {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => core
            .strip_prefix("COM")
            .or_else(|| core.strip_prefix("LPT"))
            .map(|rest| rest.len() == 1 && matches!(rest.chars().next(), Some('1'..='9')))
            .unwrap_or(false),
    }
}

/// Port of `files.ts`'s own `isUnsafeToken`: every TEXT-ONLY rejection a token must pass before
/// any filesystem call ever touches it -- NUL bytes; UNC/device paths (`\\host\share`, `\\?\...`,
/// `\\.\...`, all normalise to a leading `//` once backslashes become forward slashes); any colon
/// other than a single drive-letter prefix (blocks `javascript:`/`data:`/an NTFS alternate data
/// stream, and also catches a drive-relative token like `D:foo`); Windows reserved device names
/// per path segment.
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

/// ASCII-only case fold (matches the TS fix for the Kelvin-sign bypass, U+212A, which Unicode
/// `toLowerCase()` collapses to `'k'` even though NTFS treats them as different characters):
/// never touches non-ASCII, so this is only ever a pre-filter, never the real security boundary.
fn fold_case(value: &str) -> String {
    value.chars().map(|c| c.to_ascii_lowercase()).collect()
}

fn is_contained_in(value: &str, root: &str) -> bool {
    value == root || value.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

/// Lexically collapses `.`/`..` components without touching the filesystem (unlike
/// `Path::canonicalize`, which requires every component to exist) -- the Rust equivalent of
/// Node's `path.resolve`/`path.join` normalisation, needed because `PathBuf::join` alone leaves
/// `..` components in place.
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

/// Strips Windows' `\\?\` canonical-path prefix (and its UNC variant `\\?\UNC\`) so a
/// canonicalised path compares lexically the same way Node's `fs.realpath` output already does --
/// Rust's `std::fs::canonicalize` prepends this verbatim-path marker on Windows; Node never does.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

async fn realpath(p: &Path) -> std::io::Result<PathBuf> {
    fs::canonicalize(p).await.map(strip_verbatim_prefix)
}

enum WalkError {
    FileMissing,
    OutsideWorktree,
}

/// Port of `files.ts`'s own `resolveNoFollow`: walks `relative_suffix` one path segment at a
/// time against `root` (already realpath'd) and `unresolved_root` (the Session's own recorded
/// worktree path, never realpath'd -- covers a worktree reached through a junction/8.3 short
/// name), substituting any symlink's own raw, unfollowed target text and re-vetting it (both for
/// its own text shape via `is_unsafe_token` and for containment under either root) before
/// continuing, instead of ever handing a multi-component path to a single native resolve call
/// that would follow every link in one native call with no chance to vet an intermediate hop.
/// Capped at `MAX_LINK_HOPS` substitutions to reject a cycle rather than loop forever.
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
        // Restart from `root`, with the target's OWN relative segments prepended to whatever
        // was still pending -- the target's own path may contain further unverified links in
        // ITS OWN intermediate segments, not only at its final component.
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
    // A link that resolves, through however many hops, back to the worktree root itself must be
    // rejected the same way a top-level token equal to the root already is.
    if current == root {
        return Err(WalkError::FileMissing);
    }
    Ok(current)
}

/// Port of `files.ts`'s own `resolveNoFollowUnrooted`: generalises `resolve_no_follow` above for
/// an ABSOLUTE token with NO containment boundary (#514/#432: a user-initiated absolute path is
/// read directly, not required to stay inside any worktree) -- walks from the token's own drive
/// root one segment at a time, never handing a multi-component path to a single native resolve
/// call. A link's target is still vetted for its own TEXT shape before ever being followed.
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
    // lane's own `readImageFile` (it always reports `not-found`, like Electron's own
    // `attachments.ts`), kept for fidelity with the ported function's real return shape.
    WorktreeMissing,
}

/// Port of `files.ts`'s own `resolveInWorktree`: resolves `token` against `worktree_root`,
/// proving containment rather than assuming it. Every string-only rejection runs BEFORE any
/// filesystem call touches `token` -- a UNC path reaching `fs::canonicalize` can trigger an
/// outbound SMB authentication attempt on Windows (NTLM hash leak) even without ever actually
/// opening anything, so these must never be deferred to "resolve first, check after".
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

    // `path.resolve(resolvedRoot, token)`'s Rust equivalent: an absolute `token` overrides the
    // root entirely; a relative one (including one laden with `..`) is normalised against it.
    let candidate = if Path::new(token).is_absolute() {
        lexical_normalize(Path::new(token))
    } else {
        lexical_normalize(&resolved_root.join(token))
    };

    let resolved_root_lower = fold_case(&resolved_root.to_string_lossy());
    let unresolved_root_lower = fold_case(&unresolved_root.to_string_lossy());
    let candidate_lower = fold_case(&candidate.to_string_lossy());

    // A LEXICAL containment check on the normalised candidate, before `resolve_no_follow`/
    // `canonicalize` ever touch it -- a path outside the worktree is rejected without ever
    // resolving it. The remaining risk (a symlink/junction INSIDE the worktree pointing outside
    // it) is exactly what `resolve_no_follow` below still exists to catch.
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

    // Safe now: every segment of `walked` has already been individually vetted and had any link
    // substituted -- nothing is left in it for `canonicalize` to follow; this only canonicalises
    // casing/8.3 short names.
    let resolved_target = realpath(&walked)
        .await
        .map_err(|_| ResolveReason::FileMissing)?;

    // The REAL, final-target containment check, the actual security boundary: NO case folding --
    // both sides are already fully realpath'd, and two paths naming the same on-disk location
    // always realpath to byte-identical strings.
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

/// Port of `attachments.ts`'s own `resolveAttachmentPath`: branches on whether `token` is
/// absolute (walked with no worktree containment, #514's own "the resolved file may legitimately
/// live anywhere on disk" decision) or relative (delegates entirely to `resolve_in_worktree`).
async fn resolve_attachment_path(worktree_root: &str, token: &str) -> Option<PathBuf> {
    if is_unsafe_token(token) {
        return None;
    }
    if Path::new(token).is_absolute() {
        resolve_no_follow_unrooted(token).await
    } else {
        resolve_in_worktree(worktree_root, token).await.ok()
    }
}

/// Port of `attachments.ts`'s own `readImageFile`, the reader both #514 and #432 share. Never
/// returns the resolved path or any other file metadata beyond the validated image bytes
/// themselves. The size cap and the read both go through the SAME open handle (open -> stat ->
/// one bounded read), never a separate stat followed by a separate read -- a file swapped or
/// grown between those two calls could otherwise be read with no limit at all.
async fn read_image_file(worktree_root: &str, token: &str) -> Result<Value, IpcError> {
    let Some(real_path) = resolve_attachment_path(worktree_root, token).await else {
        return Err(not_found("That file could not be found."));
    };

    let mut file = match fs::File::open(&real_path).await {
        Ok(f) => f,
        Err(_) => return Err(not_found("That file could not be read.")),
    };
    let metadata = match file.metadata().await {
        Ok(m) => m,
        Err(_) => return Err(not_found("That file could not be read.")),
    };
    if !metadata.is_file() {
        return Err(not_found("That file could not be found."));
    }
    // Checked BEFORE ever reading the file's bytes (#514's own requirement: "check the size
    // before decoding"), against the real on-disk size from the SAME open handle.
    if metadata.len() > MAX_IMAGE_INPUT_BYTES {
        return Err(IpcError::new(
            "image-too-large",
            format!(
                "Image is too large to attach (over the {} MiB limit); nothing was attached.",
                MAX_IMAGE_INPUT_BYTES / (1024 * 1024)
            ),
        ));
    }
    // Sized from the real on-disk size (capped at the byte limit), `+ 1` so a file that GREW
    // past the cap between the stat above and this read is caught by the `bytes_read > len`
    // check below rather than silently truncated.
    let cap = (metadata.len().min(MAX_IMAGE_INPUT_BYTES) + 1) as usize;
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
    if bytes_read as u64 > metadata.len() {
        // The file changed size between the stat and this read -- refuse rather than trust a
        // read that no longer matches what was size-checked.
        return Err(not_found("That file could not be read."));
    }
    buffer.truncate(bytes_read);

    // Identified purely by content, never by filename extension.
    let header_len = buffer.len().min(24);
    let Some(mime_type) = sniff_image_mime_type(&buffer[..header_len]) else {
        return Err(IpcError::new(
            "unsupported-image-type",
            "That file is not a supported image type; nothing was attached.",
        ));
    };
    // Decompression-bomb guard (shared with the renderer's own re-encode path): every supported
    // format always carries its own dimensions in a fixed-offset header field when genuinely
    // well-formed; `None` means either a malformed/truncated file or a crafted header, refused
    // either way -- the magic-byte check above already proved the type.
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
        let worktree_root = {
            let registry = state.registry.lock().await;
            match registry.get_session(session_id) {
                Some(session) => session.worktree_path.clone(),
                None => return Err(not_found(format!("Session not found: {session_id}"))),
            }
        };
        read_image_file(&worktree_root, token).await
    })
}
