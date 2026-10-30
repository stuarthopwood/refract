// Worktree-containment security boundary. Do not simplify: each check guards against a path escape.

use std::path::{Path, PathBuf};

/// Caps link substitutions so a symlink cycle is rejected.
const MAX_LINK_HOPS: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveReason {
    OutsideWorktree,
    FileMissing,
    WorktreeMissing,
}

/// Resolved path, or the reason it was refused.
pub type ResolveInWorktreeResult = Result<PathBuf, ResolveReason>;

/// Windows reserved device names, matched case-insensitively with an optional extension.
const SIMPLE_RESERVED_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn is_com_lpt_digit(c: char) -> bool {
    matches!(c, '1'..='9' | '\u{00b9}' | '\u{00b2}' | '\u{00b3}')
}

/// Checks the tail after a reserved token: only spaces and dots, with a dot before any other character.
fn reserved_name_tail_matches(suffix: &str) -> bool {
    let chars: Vec<char> = suffix.chars().collect();
    let mut i = 0;
    let mut saw_dot = false;
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '.') {
        if chars[i] == '.' {
            saw_dot = true;
        }
        i += 1;
    }
    if i == chars.len() {
        return true;
    }
    saw_dot
}

fn starts_with_ascii_ci(chars: &[char], token: &str) -> bool {
    let token_chars: Vec<char> = token.chars().collect();
    if chars.len() < token_chars.len() {
        return false;
    }
    chars[..token_chars.len()]
        .iter()
        .zip(token_chars.iter())
        .all(|(c, t)| c.eq_ignore_ascii_case(t))
}

fn is_reserved_name_segment(segment: &str) -> bool {
    let chars: Vec<char> = segment.chars().collect();
    for token in SIMPLE_RESERVED_NAMES {
        if starts_with_ascii_ci(&chars, token) {
            let rest: String = chars[token.chars().count()..].iter().collect();
            if reserved_name_tail_matches(&rest) {
                return true;
            }
        }
    }
    for prefix in ["COM", "LPT"] {
        if starts_with_ascii_ci(&chars, prefix) {
            let after_prefix = &chars[prefix.len()..];
            if let Some(&digit) = after_prefix.first() {
                if is_com_lpt_digit(digit) {
                    let rest: String = after_prefix[1..].iter().collect();
                    if reserved_name_tail_matches(&rest) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Text-only rejection run before any filesystem call. Rejects NTFS stream colons (#723).
pub fn is_unsafe_token(value: &str) -> bool {
    if value.contains('\0') {
        return true;
    }
    if value.replace('\\', "/").starts_with("//") {
        return true;
    }
    let chars: Vec<char> = value.chars().collect();
    let colon_index = chars.iter().position(|&c| c == ':');
    let first_is_ascii_alpha = chars.first().is_some_and(|c| c.is_ascii_alphabetic());
    if let Some(idx) = colon_index {
        if !(idx == 1 && first_is_ascii_alpha) {
            return true;
        }
    }
    if chars.iter().skip(2).any(|&c| c == ':') {
        return true;
    }
    // `/^[A-Za-z]:(?![\\/])/.test(value)`: a drive-relative token (`D:foo`, or bare `D:`).
    if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        match chars.get(2) {
            None => return true,
            Some(&c2) if c2 != '\\' && c2 != '/' => return true,
            _ => {}
        }
    }
    value
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .any(is_reserved_name_segment)
}

/// ASCII-only case fold. Unicode folding would equate the Kelvin sign with `k`.
fn ascii_fold(value: &str) -> String {
    value.chars().map(|c| c.to_ascii_lowercase()).collect()
}

fn is_contained_in(value: &str, base: &str) -> bool {
    value == base || value.starts_with(&format!("{base}{}", std::path::MAIN_SEPARATOR))
}

/// Lexically joins and normalises `token` against `base`, without touching disk.
fn lexical_resolve(base: &Path, token: &str) -> PathBuf {
    let token_path = Path::new(token);
    let combined = if token_path.is_absolute() {
        token_path.to_path_buf()
    } else {
        base.join(token_path)
    };
    normalize_lexical(&combined)
}

pub(crate) fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out: Vec<std::path::Component> = Vec::new();
    for component in p.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(out.last(), Some(std::path::Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out.iter().collect()
}

/// Walks each segment with `lstat`, re-vetting link targets without `realpath`.
async fn resolve_no_follow(
    root: &Path,
    unresolved_root: &Path,
    relative_suffix: &str,
    case_insensitive: bool,
) -> Result<PathBuf, ResolveReason> {
    let fold = |s: &str| -> String {
        if case_insensitive {
            ascii_fold(s)
        } else {
            s.to_string()
        }
    };
    let root_str = root.to_string_lossy().into_owned();
    let unresolved_root_str = unresolved_root.to_string_lossy().into_owned();
    let folded_root = fold(&root_str);
    let folded_unresolved_root = fold(&unresolved_root_str);

    let mut current = root.to_path_buf();
    let mut queue: std::collections::VecDeque<String> = relative_suffix
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let mut hops: u32 = 0;

    while let Some(segment) = queue.pop_front() {
        let next = current.join(&segment);
        let lst = match tokio::fs::symlink_metadata(&next).await {
            Ok(m) => m,
            Err(_) => return Err(ResolveReason::FileMissing),
        };
        if !lst.file_type().is_symlink() {
            current = next;
            continue;
        }
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return Err(ResolveReason::OutsideWorktree);
        }
        let raw_target = match tokio::fs::read_link(&next).await {
            Ok(t) => t,
            Err(_) => return Err(ResolveReason::FileMissing),
        };
        let raw_target_str = raw_target.to_string_lossy().into_owned();
        if is_unsafe_token(&raw_target_str) {
            return Err(ResolveReason::OutsideWorktree);
        }
        let target_abs = lexical_resolve(&current, &raw_target_str);
        let target_abs_str = target_abs.to_string_lossy().into_owned();
        let folded_target = fold(&target_abs_str);
        let matched_root_str = if is_contained_in(&folded_target, &folded_root) {
            Some(&root_str)
        } else if is_contained_in(&folded_target, &folded_unresolved_root) {
            Some(&unresolved_root_str)
        } else {
            None
        };
        let Some(matched_root_str) = matched_root_str else {
            return Err(ResolveReason::OutsideWorktree);
        };
        // ASCII folding keeps byte lengths, so this slice of the original string is valid.
        let matched_root_path = Path::new(matched_root_str);
        let rel_str = target_abs_str
            .get(matched_root_str.len()..)
            .unwrap_or("")
            .trim_start_matches(std::path::MAIN_SEPARATOR);
        let mut rest: std::collections::VecDeque<String> = rel_str
            .split(['\\', '/'])
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        rest.append(&mut queue);
        queue = rest;
        current = matched_root_path.to_path_buf();
        let _ = &current;
        current = root.to_path_buf();
    }
    // A link resolving back to the root is rejected like a token equal to the root.
    if current == root {
        return Err(ResolveReason::FileMissing);
    }
    Ok(current)
}

/// Canonicalizes on a blocking thread so the async runtime is not stalled.
pub(crate) async fn canonicalize_root(path: &Path) -> Result<PathBuf, ResolveReason> {
    let owned = path.to_path_buf();
    match tokio::task::spawn_blocking(move || dunce::canonicalize(&owned)).await {
        Ok(Ok(p)) => Ok(p),
        Ok(Err(err)) => Err(match err.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                ResolveReason::WorktreeMissing
            }
            _ => ResolveReason::FileMissing,
        }),
        Err(_) => Err(ResolveReason::FileMissing),
    }
}

async fn canonicalize_target(path: &Path) -> Option<PathBuf> {
    let owned = path.to_path_buf();
    match tokio::task::spawn_blocking(move || dunce::canonicalize(&owned)).await {
        Ok(Ok(p)) => Some(p),
        _ => None,
    }
}

/// Resolves untrusted `token` under `worktree_root` and proves it stays contained.
pub async fn resolve_in_worktree(worktree_root: &Path, token: &str) -> ResolveInWorktreeResult {
    let resolved_root = canonicalize_root(worktree_root).await?;
    let unresolved_root = normalize_lexical(worktree_root);
    resolve_in_worktree_with_root(&resolved_root, &unresolved_root, token).await
}

/// Like `resolve_in_worktree`, but reuses an already-canonicalized root.
pub(crate) async fn resolve_in_worktree_with_root(
    resolved_root: &Path,
    unresolved_root: &Path,
    token: &str,
) -> ResolveInWorktreeResult {
    if is_unsafe_token(token) {
        return Err(ResolveReason::OutsideWorktree);
    }

    let candidate = lexical_resolve(resolved_root, token);
    let case_insensitive = true;
    let fold = |s: &str| -> String {
        if case_insensitive {
            ascii_fold(s)
        } else {
            s.to_string()
        }
    };
    let resolved_root_str = resolved_root.to_string_lossy().into_owned();
    let resolved_root_lower = fold(&resolved_root_str);

    let unresolved_root_str = unresolved_root.to_string_lossy().into_owned();
    let unresolved_root_lower = fold(&unresolved_root_str);

    let candidate_str = candidate.to_string_lossy().into_owned();
    let candidate_lower = fold(&candidate_str);
    let lexically_contained = is_contained_in(&candidate_lower, &resolved_root_lower)
        || is_contained_in(&candidate_lower, &unresolved_root_lower);
    if !lexically_contained {
        return Err(ResolveReason::OutsideWorktree);
    }

    if candidate_lower == resolved_root_lower || candidate_lower == unresolved_root_lower {
        return Err(ResolveReason::FileMissing);
    }

    let base_str = if is_contained_in(&candidate_lower, &resolved_root_lower) {
        &resolved_root_str
    } else {
        &unresolved_root_str
    };
    let relative_suffix = candidate_str
        .get(base_str.len()..)
        .unwrap_or("")
        .trim_start_matches(std::path::MAIN_SEPARATOR);

    let walked = resolve_no_follow(
        resolved_root,
        unresolved_root,
        relative_suffix,
        case_insensitive,
    )
    .await?;

    let Some(resolved_target) = canonicalize_target(&walked).await else {
        return Err(ResolveReason::FileMissing);
    };

    // Final check uses no case folding: both sides are realpath'd, and folding could equate distinct paths.
    let resolved_target_str = resolved_target.to_string_lossy().into_owned();
    let contained = resolved_target_str == resolved_root_str
        || resolved_target_str
            .starts_with(&format!("{resolved_root_str}{}", std::path::MAIN_SEPARATOR));
    if !contained {
        return Err(ResolveReason::OutsideWorktree);
    }

    if tokio::fs::metadata(&resolved_target).await.is_err() {
        return Err(ResolveReason::FileMissing);
    }

    Ok(resolved_target)
}

/// Stable error code for a `ResolveReason`.
pub fn resolve_reason_code(reason: ResolveReason) -> &'static str {
    match reason {
        ResolveReason::WorktreeMissing => "worktree-missing",
        ResolveReason::FileMissing => "file-missing",
        ResolveReason::OutsideWorktree => "outside-worktree",
    }
}

/// Human-readable refusal text for a `ResolveReason`.
pub fn resolve_reason_message(reason: ResolveReason, noun: &str) -> String {
    match reason {
        ResolveReason::WorktreeMissing => {
            "This Session's worktree folder no longer exists".to_string()
        }
        ResolveReason::FileMissing => {
            format!("Couldn't find that {noun} in this Session's worktree")
        }
        ResolveReason::OutsideWorktree => {
            // Tells the user how to fix it (#1111).
            "That path is outside this Session's worktree. Choose a file inside the worktree instead.".to_string()
        }
    }
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
