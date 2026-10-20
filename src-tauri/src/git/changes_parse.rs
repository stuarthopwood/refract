// Split out of `changes_status.rs` (issue #806 "no god files" convention, already followed by
// this file's own siblings `changes_score.rs`/`changes_diff.rs`): gate round 1 item 5 (issue
// #464)'s dual-membership redesign pushed `changes_status.rs` back over the 600-line soft cap,
// so its porcelain v2 parsing/grouping step -- `ParsedEntry`/`ParsedGroups`/`GitChangesGroup` and
// every `parse_*` function -- moves here, behaviour (plus the item 5 redesign itself) unchanged.
// See `changes_status.rs`'s own header comment for the full FR-002 dual-membership decision.

use crate::fs::paths::contains_git_segment;

use super::changes_status::AheadBehind;
use super::status::GitStatusMark;

/// One of the four fixed buckets every non-ignored status entry sorts into (FR-002, data-model.md
/// "Git changes group"). Internal to the parsing/grouping step -- never serialised on its own;
/// group membership reaches the wire purely as which list (`GitChangesGroups`'s own fields) a
/// `GitChangesFileEntry` appears in. Gate round 1 item 5 (issue #464): a single parsed entry can
/// now produce up to two `(group, mark)` pairs (see `ParsedGroups`), so this is no longer a
/// strict 1:1 "bucket per entry" -- it is still a strict 1:1 "bucket per produced ROW".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GitChangesGroup {
    Conflicts,
    Staged,
    Changes,
    Untracked,
}

/// One already-classified status entry, before its own additions/deletions are scored --
/// `build_groups` fills those in with a second pass (the two numstat reads it needs run once
/// each for every entry, not once per entry). `groups` is 1-or-2 `(group, mark)` pairs (gate
/// round 1 item 5, issue #464): a partially-staged ordinary/rename entry (both XY columns
/// non-`.`) produces two independent rows for the SAME `path` -- see `changes_status.rs`'s own
/// header comment for the decision, and `group_marks_for_xy` for how the pairs are derived.
pub(super) struct ParsedEntry {
    pub(super) path: String,
    pub(super) groups: ParsedGroups,
}

/// Up to two `(GitChangesGroup, GitStatusMark)` pairs for one parsed status line -- a fixed-size
/// inline array (never a `Vec`), since the count is always known (1 or 2) at construction.
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

/// The Staged-half mark for an ordinary/rename entry, driven ONLY by the X column (gate round 1
/// item 5, issue #464): `D` -> Deleted, `A` -> Added, otherwise `Staged` -- the SAME rule for
/// both record types, so a partially-staged rename's own Staged-half row reads `Staged`, not
/// `Renamed` (X is `R` there, never `D`/`A`); `Renamed` survives only for a rename with nothing
/// further pending in the worktree (Y == `.`), handled as its own special case in
/// `parse_rename_entry` rather than here.
fn staged_half_mark(x: u8) -> GitStatusMark {
    if x == b'D' {
        GitStatusMark::Deleted
    } else if x == b'A' {
        GitStatusMark::Added
    } else {
        GitStatusMark::Staged
    }
}

/// The Changes-half mark for an ordinary/rename entry, driven ONLY by the Y column: `D` ->
/// Deleted, otherwise `Modified` -- Y is only ever `M`/`D`/`T` for an ordinary entry per git's
/// own porcelain v2 format, never `A`/`R` (gate round 1 item 5, issue #464).
fn changes_half_mark(y: u8) -> GitStatusMark {
    if y == b'D' {
        GitStatusMark::Deleted
    } else {
        GitStatusMark::Modified
    }
}

/// FR-002's own grouping rule, amended by gate round 1 item 5 (issue #464, decision recorded in
/// `specs/018-git-changes-panel/spec.md`'s own FR-002): a non-`.` Y column means there is still
/// a pending UNSTAGED edit; a non-`.` X column means something is staged. A record with BOTH
/// non-`.` (partially staged, like VS Code) now produces BOTH halves -- Staged (X-driven mark)
/// AND Changes (Y-driven mark) -- as two separate rows for the same path, rather than picking
/// one. Applies uniformly to ordinary and rename/copy entries alike (a rename is always carried
/// by the index, per git's own porcelain v2 format -- a worktree-only move is reported as a
/// plain delete+untracked-add pair, never a `2` record).
fn group_marks_for_xy(xy: &[u8]) -> ParsedGroups {
    let (x, y) = (xy[0], xy[1]);
    let staged = (GitChangesGroup::Staged, staged_half_mark(x));
    let changes = (GitChangesGroup::Changes, changes_half_mark(y));
    match (x != b'.', y != b'.') {
        (true, true) => ParsedGroups::two(staged, changes),
        (true, false) => ParsedGroups::one(staged),
        // `(false, false)` should not occur for a listed entry (both columns unchanged);
        // Changes is the safer default -- it still shows the row rather than silently dropping
        // it, same as the pre-item-5 fallback.
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

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`: 7 space-separated fields before `path`, which
/// is the remainder (never re-split -- a path itself may contain spaces).
fn parse_ordinary_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("1 ")?;
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    for _ in 0..6 {
        parts.next()?; // sub, mH, mI, mW, hH, hI
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

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`, with `<origPath>` as its own
/// SEPARATE NUL-terminated token right after (consumed by the caller's own `tokens.next()`,
/// mirroring `status.rs::parse_status`'s identical handling of a v1 rename's extra field).
fn parse_rename_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("2 ")?;
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    for _ in 0..7 {
        parts.next()?; // sub, mH, mI, mW, hH, hI, Xscore
    }
    let path = parts.next()?;
    if xy.len() != 2 || contains_git_segment(path) {
        return None;
    }
    let xy_bytes = xy.as_bytes();
    let groups = if xy_bytes[1] == b'.' {
        // Nothing further pending in the worktree: single Staged row, `Renamed` mark preserved
        // exactly as before item 5 -- only the dual-membership (Y != '.') case below is new.
        ParsedGroups::one((GitChangesGroup::Staged, GitStatusMark::Renamed))
    } else {
        group_marks_for_xy(xy_bytes)
    };
    Some(ParsedEntry {
        path: path.to_string(),
        groups,
    })
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: always Conflicts/Conflicted
/// regardless of its own XY (FR-002: "a conflicted entry always sorted into Conflicts
/// regardless of any other mark it might otherwise also carry") -- always exactly one row,
/// unaffected by gate round 1 item 5's dual-membership change.
fn parse_unmerged_entry(entry: &str) -> Option<ParsedEntry> {
    let rest = entry.strip_prefix("u ")?;
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next()?;
    for _ in 0..8 {
        parts.next()?; // sub, m1, m2, m3, mW, h1, h2, h3
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

/// Parses `-z`-delimited `status --porcelain=v2 --branch` output: header lines into the branch
/// name and ahead/behind pair, and `1`/`2`/`u`/`?` entry lines into `ParsedEntry`s. `!` (ignored)
/// lines are skipped outright (FR-002 "every non-ignored status entry") -- none are expected
/// since `--ignored` is never passed, but a line in that shape is still defensively dropped
/// rather than misparsed. Every slice is `get`/`strip_prefix`-based (never indexed directly,
/// matching `status.rs::parse_status`'s own discipline): a malformed or truncated entry is
/// skipped, never a panic.
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
                tokens.next(); // origPath: never a row of its own, discarded
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
            _ => {} // "!" (ignored, not requested) or malformed -- skipped
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
