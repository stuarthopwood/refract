// Spec 024 FR-005/FR-006 (#538): the right pane's own persisted state -- open or collapsed,
// width, open panel ids in tab order, the active tab. A child module of `settings.rs` (not
// inline there) to keep that file under this build's 600-line cap (issue #806), the same reason
// `agent_stopped_bar.rs` was split out. The renderer's `right-pane-persistence.ts` is the sole
// writer and never reads a broadcast back, so there is no raw/lazy-correction tracking.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "rightPane";
pub(crate) const WIDTH_DEFAULT: i64 = 320;
pub(crate) const WIDTH_MIN: i64 = 240;
// Matches the renderer's RIGHT_PANE_MAX_WIDTH_PX.
pub(crate) const WIDTH_MAX: i64 = 520;
// A floor under a hand-edited settings.json or a renderer bug, far above the six real panels.
const MAX_IDS: usize = 16;
const MAX_ID_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RightPaneState {
    pub open: bool,
    pub width_px: i64,
    pub open_panel_ids: Vec<String>,
    pub active_panel_id: Option<String>,
    /// Issue #730: the user's saved panel order (empty means the default). May hold ids this
    /// build does not register; the renderer keeps and merges them.
    #[serde(default)]
    pub panel_order: Vec<String>,
}

pub(super) fn default_state() -> RightPaneState {
    RightPaneState {
        open: false,
        width_px: WIDTH_DEFAULT,
        open_panel_ids: Vec::new(),
        active_panel_id: None,
        panel_order: Vec::new(),
    }
}

/// Distinct string ids, each within `MAX_ID_BYTES`, at most `MAX_IDS`; anything else is malformed.
fn parse_ids(ids: &[Value]) -> Option<Vec<String>> {
    if ids.len() > MAX_IDS {
        return None;
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(ids.len());
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.as_str()?;
        if id.len() > MAX_ID_BYTES {
            return None;
        }
        if seen.insert(id) {
            out.push(id.to_string());
        }
    }
    Some(out)
}

/// Shared by the disk loader (malformed resets to the default) and the IPC setter (malformed is
/// `invalid-argument`). Width is clamped, ids are de-duplicated (over the cap or a non-string is
/// malformed), and an active id outside `openPanelIds` is repaired to the last open tab.
pub(crate) fn parse(value: &Value) -> Option<RightPaneState> {
    let object = value.as_object()?;
    let open = object.get("open")?.as_bool()?;
    let width_px = object.get("widthPx")?.as_i64()?.clamp(WIDTH_MIN, WIDTH_MAX);
    let open_panel_ids = parse_ids(object.get("openPanelIds")?.as_array()?)?;
    let panel_order = match object.get("panelOrder") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => parse_ids(v.as_array()?)?,
    };
    let active = match object.get("activePanelId") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str()?.to_string()),
    };
    let active_panel_id = match active {
        Some(id) if open_panel_ids.contains(&id) => Some(id),
        _ => open_panel_ids.last().cloned(),
    };
    Some(RightPaneState {
        open,
        width_px,
        open_panel_ids,
        active_panel_id,
        panel_order,
    })
}

/// A missing, null or malformed key is the default (no migration needed).
pub(super) fn parse_from_disk(object: &Map<String, Value>) -> RightPaneState {
    object
        .get(KEY)
        .and_then(parse)
        .unwrap_or_else(default_state)
}

impl SettingsStore {
    /// `settings.setRightPane(value)`: plain-replace shape, as `set_session_list_collapse` uses.
    pub async fn set_right_pane(&mut self, value: RightPaneState) -> std::io::Result<Settings> {
        let next = Settings {
            right_pane: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
