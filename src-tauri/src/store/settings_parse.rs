// Pure lazy-correction parsers and clamps for `settings.json`.
use std::collections::HashSet;

use serde_json::Value;

use super::{SessionListCollapse, SessionReadout, SplitLayout};

/// Default session readout flags.
fn default_session_readout() -> SessionReadout {
    SessionReadout {
        changes: true,
        context_usage: true,
        turn_time: true,
        current_time: false,
        subagents: true,
        todo_progress: true,
        current_work: true,
    }
}

/// Reads each flag on its own, defaulting a missing or non-boolean one; a non-object row is
/// the whole default.
pub(super) fn parse_session_readout(value: Option<&Value>) -> SessionReadout {
    value
        .and_then(Value::as_object)
        .map(|o| {
            let flag =
                |key: &str, default: bool| o.get(key).and_then(Value::as_bool).unwrap_or(default);
            SessionReadout {
                changes: flag("changes", true),
                context_usage: flag("context-usage", true),
                turn_time: flag("turn-time", true),
                current_time: flag("current-time", false),
                subagents: flag("subagents", true),
                todo_progress: flag("todo-progress", true),
                current_work: flag("current-work", true),
            }
        })
        .unwrap_or_else(default_session_readout)
}

/// A malformed `split` (hand-edited or from another build) resets to `None`. Arrays are rejected
/// explicitly.
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

/// A malformed `sessionListCollapse` resets to the default; duplicate ids are de-duplicated (#735).
pub(super) fn default_session_list_collapse() -> SessionListCollapse {
    SessionListCollapse {
        collapsed_repository_ids: Vec::new(),
        archived_open: false,
        show_hidden: false,
    }
}

/// De-dupes and caps `collapsedRepositoryIds`, shared by disk parser and IPC setter; `None` on
/// a cap breach or non-string element.
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
    let show_hidden = object
        .get("showHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(SessionListCollapse {
        collapsed_repository_ids,
        archived_open,
        show_hidden,
    })
}

/// Named so the `settings.rs` default and this clamp's bounds cannot drift apart (#930).
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
