// Split from changes_status.rs to keep it under the 600-line cap (#806).

use crate::fs::paths::contains_git_segment;

use super::changes_status::AheadBehind;
use super::status::GitStatusMark;

/// One of the four fixed buckets a non-ignored status row sorts into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GitChangesGroup {
    Conflicts,
    Staged,
    Changes,
    Untracked,
}

/// A classified status entry; `groups` holds one or two rows for the same path.
pub(super) struct ParsedEntry {
    pub(super) path: String,
    pub(super) groups: ParsedGroups,
}

/// One or two `(group, mark)` pairs; a fixed-size array avoids a `Vec` allocation.
#[derive(Clone, Copy)]
pub(super) struct ParsedGroups {
    items: [(GitChangesGroup, GitStatusMark); 2],
    len: u8,
}

impl ParsedGroups {
    fn one(item: (GitChangesGroup, GitStatusMark)) -> Self {
        Self {
            items: [item, item],
            len: 1,
        }
    }

    fn two(
        first: (GitChangesGroup, GitStatusMark),
        second: (GitChangesGroup, GitStatusMark),
    ) -> Self {
        Self {
            items: [first, second],
            len: 2,
        }
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (GitChangesGroup, GitStatusMark)> + '_ {
        self.items[..self.len as usize].iter().copied()
    }
}

/// Staged-half mark, driven by the X column only. A rename's X is `R`, so it reads `Staged`
/// here; `Renamed` is handled in `parse_rename_entry`.
fn staged_half_mark(x: u8) -> GitStatusMark {
    if x == b'D' {
        GitStatusMark::Deleted
    } else if x == b'A' {
        GitStatusMark::Added
    } else {
        GitStatusMark::Staged
    }
}

/// Changes-half mark, driven by the Y column only.
fn changes_half_mark(y: u8) -> GitStatusMark {
    if y == b'D' {
        GitStatusMark::Deleted
    } else {
        GitStatusMark::Modified
    }
}

/// A non-`.` X means staged; a non-`.` Y means an unstaged edit. Both non-`.` yields two rows
/// (partially staged, like VS Code).
fn group_marks_for_xy(xy: &[u8]) -> ParsedGroups {
    let (x, y) = (xy[0], xy[1]);
    let staged = (GitChangesGroup::Staged, staged_half_mark(x));
    let changes = (GitChangesGroup::Changes, changes_half_mark(y));
    match (x != b'.', y != b'.') {
        (true, true) => ParsedGroups::two(staged, changes),
        (true, false) => ParsedGroups::one(staged),
        // Not expected for a listed entry; Changes keeps the row visible rather than dropping it.
        (false, true) | (false, false) => ParsedGroups::one(changes),
    }
}

fn parse_ahead_behind(value: &str) -> Option<AheadBehind> {
    let mut parts = value.split_whitespace();
    let ahead_raw = parts.next()?;
    let behind_raw = parts.next()?;
    let ahead = ahead_raw.strip_prefix('+')?.parse::<i64>().ok()?;
    let behind = behind_raw.strip_prefix('-')?.parse::<i64>().ok()?;
    Some(AheadBehind { ahead, behind })
}

/// Parses a `1` record. The path is the remainder, never re-split, since it may contain spaces.
fn parse_ordinary_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("1 ")?;
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    for _ in 0..6 {
        parts.next()?;
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    Some(ParsedEntry {
        path: path.to_string(),
        groups: group_marks_for_xy(xy.as_bytes()),
    })
}

/// Parses a `2` record. The original path is a separate NUL token, consumed by the caller.
fn parse_rename_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("2 ")?;
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    for _ in 0..7 {
        parts.next()?;
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    let xy_bytes = xy.as_bytes();
    let groups = if xy_bytes[1] == b'.' {
        // Nothing pending in the worktree: a single Staged row with the `Renamed` mark.
        ParsedGroups::one((GitChangesGroup::Staged, GitStatusMark::Renamed))
    } else {
        group_marks_for_xy(xy_bytes)
    };
    Some(ParsedEntry {
        path: path.to_string(),
        groups,
    })
}

/// Parses a `u` record. Always one Conflicts row, whatever its XY.
fn parse_unmerged_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("u ")?;
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next()?;
    for _ in 0..8 {
        parts.next()?;
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    Some(ParsedEntry {
        path: path.to_string(),
        groups: ParsedGroups::one((GitChangesGroup::Conflicts, GitStatusMark::Conflicted)),
    })
}

/// Parses `-z` porcelain v2 output into the branch, ahead/behind, and entries. Malformed
/// lines are skipped via `get`/`strip_prefix`, never a panic.
pub(super) fn parse_porcelain_v2(
    stdout: &str,
) -> (Option<String>, Option<AheadBehind>, Vec<ParsedEntry>) {
    let mut branch: Option<String> = None;
    let mut ahead_behind: Option<AheadBehind> = None;
    let mut entries = Vec::new();

    let mut tokens = stdout.split('\0');
    while let Some(entry) = tokens.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            if let Some(value) = header.strip_prefix("branch.head ") {
                if value != "(detached)" {
                    branch = Some(value.to_string());
                }
            } else if let Some(value) = header.strip_prefix("branch.ab ") {
                ahead_behind = parse_ahead_behind(value);
            }
            continue;
        }
        match entry.get(0..1) {
            Some("1") => {
                if let Some(parsed) = parse_ordinary_entry(entry) {
                    entries.push(parsed);
                }
            }
            Some("2") => {
                if let Some(parsed) = parse_rename_entry(entry) {
                    entries.push(parsed);
                }
                tokens.next(); // origPath: discarded
            }
            Some("u") => {
                if let Some(parsed) = parse_unmerged_entry(entry) {
                    entries.push(parsed);
                }
            }
            Some("?") => {
                if let Some(path) = entry.get(2..) {
                    if !contains_git_segment(path) {
                        entries.push(ParsedEntry {
                            path: path.to_string(),
                            groups: ParsedGroups::one((
                                GitChangesGroup::Untracked,
                                GitStatusMark::Untracked,
                            )),
                        });
                    }
                }
            }
            _ => {} // Ignored (`!`) or malformed lines are skipped.
        }
    }
    (branch, ahead_behind, entries)
}

pub(super) fn folder_for(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => String::new(),
    }
}
