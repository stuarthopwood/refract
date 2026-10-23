// Lazy-correction parsers and clamps for `settings.json`'s own per-field validate-then-default
// pattern (split out of `settings.rs` to stay under the 600-line-per-file cap, issue #806):
// `settings.rs` keeps the `Settings`/`SettingsStore` shapes and the open/persist/setter
// orchestration; this file is pure, side-effect-free parsing/clamping helpers only.
use std::collections::HashSet;

use serde_json::Value;

use super::{SessionListCollapse, SplitLayout};

/// Spec 005 data-model.md "Validation"/"Migration": a present-but-malformed `split` (hand-edited,
/// or from a future/older build) is reset to `None` rather than trusted, the same lazy-correction
/// pattern `settings.ts`'s own `isValidSplitLayout` uses. Rejects a JSON array explicitly (`typeof
/// [] === 'object'` in JS let one slip through the old, weaker check) since `serde_json::Value`
/// distinguishes `Array` from `Object` directly.
pub(super) fn parse_split_layout(value: &Value) -> Option<SplitLayout> {
    let object = value.as_object()?;
    let session_ids = object.get("sessionIds")?.as_array()?;
    if session_ids.len() != 2 {
        return None;
    }
    let first = session_ids[0].as_str()?;
    let second = session_ids[1].as_str()?;
    if first == second {
        return None;
    }
    let divider_percent = object.get("dividerPercent")?.as_f64()?;
    if !divider_percent.is_finite() || !(0.0..=100.0).contains(&divider_percent) {
        return None;
    }
    let focused_index = match object.get("focusedIndex")?.as_i64()? {
        0 => 0u8,
        1 => 1u8,
        _ => return None,
    };
    Some(SplitLayout {
        session_ids: [first.to_string(), second.to_string()],
        divider_percent,
        focused_index,
    })
}

/// #735 data-model.md: a present-but-malformed `sessionListCollapse` resets to the default
/// (`{ collapsedRepositoryIds: [], archivedOpen: false }`), the same lazy-correction pattern
/// `parse_split_layout` uses. De-duplicates `collapsedRepositoryIds` (a hand-edited file could
/// repeat an id).
pub(super) fn default_session_list_collapse() -> SessionListCollapse {
    SessionListCollapse {
        collapsed_repository_ids: Vec::new(),
        archived_open: false,
    }
}

/// Gate round 2 fix (Low, security-auditor + code-reviewer): shared de-dupe-and-cap pass for
/// `collapsedRepositoryIds`, used by both the disk parser above and the IPC setter
/// (`ipc/settings.rs::parse_session_list_collapse_arg`) so the two can never drift apart again.
/// Caps at 1,000 ids (far more than any real profile's Repository count) and 256 bytes per id
/// (well over any real Repository id's length), a floor under a hand-edited `settings.json` or
/// a renderer bug, not a real workflow. Duplicate ids are REMOVED, never rejected
/// (contracts/ipc.md), the same lazy-correction pattern the rest of this file already uses. A
/// `HashSet` membership check replaces the previous `Vec::iter().any()` scan (O(n) instead of
/// O(n^2)). Returns `None` once either cap is exceeded or an element is not a string -- the IPC
/// caller turns that into `invalid-argument`; the disk loader's own caller resets to the
/// default, exactly like any other malformed field here.
pub(crate) const SESSION_LIST_COLLAPSE_MAX_IDS: usize = 1000;
pub(crate) const SESSION_LIST_COLLAPSE_MAX_ID_BYTES: usize = 256;

pub(crate) fn sanitize_collapsed_repository_ids(ids_value: &[Value]) -> Option<Vec<String>> {
    if ids_value.len() > SESSION_LIST_COLLAPSE_MAX_IDS {
        return None;
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(ids_value.len());
    let mut collapsed_repository_ids: Vec<String> = Vec::with_capacity(ids_value.len());
    for id in ids_value {
        let id = id.as_str()?;
        if id.len() > SESSION_LIST_COLLAPSE_MAX_ID_BYTES {
            return None;
        }
        if seen.insert(id) {
            collapsed_repository_ids.push(id.to_string());
        }
    }
    Some(collapsed_repository_ids)
}

pub(super) fn parse_session_list_collapse(value: &Value) -> Option<SessionListCollapse> {
    let object = value.as_object()?;
    let ids_value = object.get("collapsedRepositoryIds")?.as_array()?;
    let collapsed_repository_ids = sanitize_collapsed_repository_ids(ids_value)?;
    let archived_open = object.get("archivedOpen")?.as_bool()?;
    Some(SessionListCollapse {
        collapsed_repository_ids,
        archived_open,
    })
}

/// #930 gate-fix (M8, caught live 2026-10-18): named, not bare, so `settings.rs`'s own
/// `.unwrap_or(...)` default and this clamp's bounds can never drift apart from each other or
/// from `pull-requests-layout-store.ts`'s own `PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX`/`_MIN_WIDTH_PX`
/// (320/280; the renderer's own `maxSize="50%"` has no fixed Rust-side counterpart).
pub(crate) const PULL_REQUESTS_LIST_WIDTH_PX_DEFAULT: i64 = 320;
pub(crate) const PULL_REQUESTS_LIST_WIDTH_PX_MIN: i64 = 280;
pub(crate) const PULL_REQUESTS_LIST_WIDTH_PX_MAX: i64 = 4000;

/// #930: clamps a corrupt/out-of-range value; the renderer enforces its own live min/50%-of-view max too.
pub(crate) fn clamp_pull_requests_list_width_px(value: i64) -> i64 {
    value.clamp(
        PULL_REQUESTS_LIST_WIDTH_PX_MIN,
        PULL_REQUESTS_LIST_WIDTH_PX_MAX,
    )
}
