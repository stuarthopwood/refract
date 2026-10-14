// Port of `src/main/ipc/files.ts`'s own `isUnsafeToken`/`resolveNoFollow`/`resolveInWorktree`
// (lane R7, issue #790): the worktree-containment security boundary. **Do not simplify** (issue
// #790's own words) -- every gate-round fix cited in the Electron source's comments is carried
// over here; this file's doc comments reference the exact TS comment the logic mirrors rather
// than restating the reasoning, so the two can be diffed side by side.
//
// Deliberately excludes `resolveNoFollowUnrooted` (the unrooted absolute-path walk `attachments.ts`
// uses, #514/#432): no channel in this lane's scope (issue #790's channel list) ever resolves an
// unrooted absolute token, and porting it here with no caller would be untested dead code.

use std::path::{Path, PathBuf};

/// Bounds how many link substitutions `resolve_no_follow` walks before rejecting a cycle outright
/// (`a -> b -> a`) -- mirrors `files.ts`'s own `MAX_LINK_HOPS`.
const MAX_LINK_HOPS: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveReason {
    OutsideWorktree,
    FileMissing,
    WorktreeMissing,
}

pub type ResolveInWorktreeResult = Result<PathBuf, ResolveReason>;

/// Windows reserved device names (case-insensitive, with or without a trailing extension) --
/// mirrors `files.ts`'s own `RESERVED_NAME_RE`:
/// `/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[1-9\u00b9\u00b2\u00b3])[ .]*(\.[^\\/]*)?$/i`.
/// Hand-written rather than pulled through a `regex` crate dependency (none exists in this
/// build's `Cargo.toml`): the shape is a fixed token list plus a small tail grammar, both cheap
/// and more legible written out directly than behind a regex engine for one call site.
const SIMPLE_RESERVED_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn is_com_lpt_digit(c: char) -> bool {
    matches!(c, '1'..='9' | '\u{00b9}' | '\u{00b2}' | '\u{00b3}')
}

/// Matches the regex's own trailing `[ .]*(\.[^\\/]*)?$` against whatever follows an exactly-
/// matched reserved token within one path segment (never containing `\`/`/`, already split out
/// by the caller, so `[^\\/]*` there is equivalent to "anything remaining"). Derivation: the
/// suffix satisfies the pattern iff it is entirely made of spaces/dots, OR its leading run of
/// spaces/dots contains at least one dot (which the optional group's own leading literal `.` can
/// then anchor on, absorbing everything after via `[^\\/]*`).
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

/// Every TEXT-ONLY rejection a token must pass before any filesystem call ever touches it --
/// mirrors `files.ts`'s own `isUnsafeToken` doc comment and body exactly, including the PR #723
/// gate round 1 fix (a second colon anywhere from index 2 onward is rejected, catching an NTFS
/// alternate-data-stream marker after a legitimate drive prefix).
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

/// ASCII-only case fold (`/[A-Z]/g` replace, never Unicode `to_lowercase`): the Kelvin-sign fix
/// (gate round 5, Sec4 Medium) -- `U+212A` must never compare equal to `k`/`K` here.
fn ascii_fold(value: &str) -> String {
    value.chars().map(|c| c.to_ascii_lowercase()).collect()
}

fn is_contained_in(value: &str, base: &str) -> bool {
    value == base || value.starts_with(&format!("{base}{}", std::path::MAIN_SEPARATOR))
}

/// Lexical `path.resolve(base, token)` equivalent: collapses `.`/`..` without touching disk,
/// clamping a `..` at an already-absolute root rather than escaping above it (`Path::components`
/// already classifies prefix/root/`.`/`..`/normal segments for us, so this is a thin fold over
/// that iterator rather than a hand-rolled string parser).
fn lexical_resolve(base: &Path, token: &str) -> PathBuf {
    let token_path = Path::new(token);
    let combined = if token_path.is_absolute() {
        token_path.to_path_buf()
    } else {
        base.join(token_path)
    };
    normalize_lexical(&combined)
}

fn normalize_lexical(p: &Path) -> PathBuf {
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

/// Walks `relative_suffix` one path segment at a time via `lstat`/`readlink` -- never `realpath`
/// -- substituting and re-vetting any symlink/junction target before continuing the walk, exactly
/// as `files.ts`'s own `resolveNoFollow` describes in its (long) doc comment: a target may match
/// either `root` (realpath'd) or `unresolved_root` (the Session's own recorded, un-realpath'd
/// worktree path, for a worktree reached through its own junction/8.3 alias), but the walk always
/// restarts from `root`.
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
        // Folding only ever changes ASCII case (never byte length), so slicing the ORIGINAL
        // (unfolded) `target_abs_str` at the folded match's byte length is safe and yields the
        // true-cased relative remainder.
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
        let _ = &current; // `current` is reset to `root` below, matching the TS restart-from-root
        current = root.to_path_buf();
    }
    // A link that resolves, through however many hops, back to the worktree root itself must be
    // rejected the same way a top-level token equal to the root already is.
    if current == root {
        return Err(ResolveReason::FileMissing);
    }
    Ok(current)
}

/// Canonicalizes `path` on a blocking-pool thread (perf finding: `dunce::canonicalize` is a
/// synchronous syscall; called inline on a tokio worker it stalls every other task on that
/// worker, and `classify_symlink_entry` can call this indirectly up to 1000 times per listing
/// across 8 concurrently running tasks). Maps a `NotFound`/`NotADirectory` failure to
/// `WorktreeMissing`, any other failure (including a `spawn_blocking` join failure) to
/// `FileMissing`.
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

/// Resolves `token` (untrusted: agent/tool/model-authored text) against `worktree_root`, proving
/// containment rather than assuming it -- the Rust port of `files.ts`'s own `resolveInWorktree`.
/// Windows-only build (spec.md Assumptions): `case_insensitive` is always `true`. Thin wrapper
/// over `resolve_in_worktree_with_root` that canonicalizes `worktree_root` once; callers that
/// already hold that canonicalized root from an earlier step in the SAME listing (symlink
/// classification, up to 1000 times per directory) call the shared-root variant directly instead
/// of paying for a redundant canonicalize on every entry (perf finding).
pub async fn resolve_in_worktree(worktree_root: &Path, token: &str) -> ResolveInWorktreeResult {
    let resolved_root = canonicalize_root(worktree_root).await?;
    let unresolved_root = normalize_lexical(worktree_root);
    resolve_in_worktree_with_root(&resolved_root, &unresolved_root, token).await
}

/// Same containment proof as `resolve_in_worktree`, but takes an ALREADY-canonicalized
/// `resolved_root` (and its matching lexically-normalised `unresolved_root`) instead of
/// canonicalizing `worktree_root` itself again -- see that function's own doc comment. `pub(crate)`
/// so `fs::list_directory`'s own `classify_symlink_entry` can reuse the root it already
/// canonicalized once per listing.
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

    // The REAL, final-target containment check: no case folding at all here (gate round 5, Sec4
    // Medium) -- both sides are already fully realpath'd, and any folding transform (including
    // the ASCII-only one used for the lexical pre-check above) could make two DIFFERENT on-disk
    // paths compare equal.
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

/// Shared by every caller of `resolve_in_worktree`/`resolve_list_target` to map a `ResolveReason`
/// to the SAME error code and message (DRY fix, code-reviewer MEDIUM: `ipc::files::
/// resolve_error_result` and `fs::list_directory`'s own mapping used to each hardcode these
/// strings independently). `noun` lets each call site say "file" or "folder".
pub fn resolve_reason_code(reason: ResolveReason) -> &'static str {
    match reason {
        ResolveReason::WorktreeMissing => "worktree-missing",
        ResolveReason::FileMissing => "file-missing",
        ResolveReason::OutsideWorktree => "outside-worktree",
    }
}

pub fn resolve_reason_message(reason: ResolveReason, noun: &str) -> String {
    match reason {
        ResolveReason::WorktreeMissing => {
            "This Session's worktree folder no longer exists".to_string()
        }
        ResolveReason::FileMissing => {
            format!("Couldn't find that {noun} in this Session's worktree")
        }
        ResolveReason::OutsideWorktree => {
            "That path is outside this Session's worktree".to_string()
        }
    }
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
