// Right pane persisted state (#538).
// The renderer is the sole writer, so there is no raw/lazy-correction tracking.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "rightPane";
pub(crate) const WIDTH_DEFAULT: i64 = 320;
pub(crate) const WIDTH_MIN: i64 = 240;
// Matches the renderer's RIGHT_PANE_SANITY_MAX_WIDTH_PX: a ceiling against a corrupt row, not a layout cap (#2075).
pub(crate) const WIDTH_MAX: i64 = 4096;
// A floor under a hand-edited settings.json or a renderer bug, far above the six real panels.
const MAX_IDS: usize = 16;
const MAX_ID_BYTES: usize = 64;
// A Session id is a UUID today; the bound only stops a corrupt key from growing the row.
const MAX_SESSION_ID_BYTES: usize = 128;
// Mirrors the renderer's MAX_DOCUMENT_TABS_PER_SESSION and MAX_DOCUMENT_PATH_BYTES (src/shared/rightPane.ts).
const MAX_DOCUMENT_TABS: usize = 20;
const MAX_DOCUMENT_PATH_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RightPaneState {
    pub open: bool,
    pub width_px: i64,
    pub open_panel_ids: Vec<String>,
    pub active_panel_id: Option<String>,
    /// Saved panel order (#730); may hold unregistered ids, which the renderer keeps.
    #[serde(default)]
    pub panel_order: Vec<String>,
    /// File and diff tabs per Session (#2075); a BTreeMap keeps the saved row stable.
    #[serde(default)]
    pub document_tabs: BTreeMap<String, SessionDocumentTabs>,
    /// The user's chat-hidden preference (#2075); the renderer applies it only in the chat view.
    #[serde(default)]
    pub chat_collapsed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    File,
    Diff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffGroup {
    Conflicts,
    Staged,
    Changes,
    Untracked,
}

impl DiffGroup {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "conflicts" => Some(Self::Conflicts),
            "staged" => Some(Self::Staged),
            "changes" => Some(Self::Changes),
            "untracked" => Some(Self::Untracked),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Conflicts => "conflicts",
            Self::Staged => "staged",
            Self::Changes => "changes",
            Self::Untracked => "untracked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTab {
    pub kind: DocumentKind,
    /// Set for a diff tab only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<DiffGroup>,
    pub path: String,
}

impl DocumentTab {
    /// The identity the renderer keys `activeId` and `recency` by.
    fn id(&self) -> String {
        match (self.kind, self.group) {
            (DocumentKind::Diff, Some(group)) => format!("diff:{}:{}", group.as_str(), self.path),
            _ => format!("file:{}", self.path),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDocumentTabs {
    pub tabs: Vec<DocumentTab>,
    pub active_id: Option<String>,
    /// Tab ids, least recently active first.
    pub recency: Vec<String>,
}

pub(super) fn default_state() -> RightPaneState {
    RightPaneState {
        open: false,
        width_px: WIDTH_DEFAULT,
        open_panel_ids: Vec::new(),
        active_panel_id: None,
        panel_order: Vec::new(),
        document_tabs: BTreeMap::new(),
        chat_collapsed: false,
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

/// Worktree-relative POSIX paths only, the same rules as the renderer's `normaliseRelativePath`
/// (src/shared/rightPane.ts); an absolute or parent-escaping path must never reach a tab.
fn is_relative_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > MAX_DOCUMENT_PATH_BYTES
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
    {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn parse_tab(value: &Value) -> Option<DocumentTab> {
    let object = value.as_object()?;
    let path = object.get("path")?.as_str()?;
    if !is_relative_path(path) {
        return None;
    }
    let group = match object.get("group") {
        None | Some(Value::Null) => None,
        Some(v) => Some(DiffGroup::parse(v.as_str()?)?),
    };
    let kind = match (object.get("kind")?.as_str()?, group) {
        ("file", None) => DocumentKind::File,
        ("diff", Some(_)) => DocumentKind::Diff,
        _ => return None,
    };
    Some(DocumentTab {
        kind,
        group,
        path: path.to_string(),
    })
}

/// Drops invalid and repeated tabs; a Session over the per-Session cap, or left with no tab, is dropped whole.
fn parse_session_tabs(value: &Value) -> Option<SessionDocumentTabs> {
    let object = value.as_object()?;
    let raw = object.get("tabs")?.as_array()?;
    if raw.len() > MAX_DOCUMENT_TABS {
        return None;
    }
    let mut seen: HashSet<String> = HashSet::with_capacity(raw.len());
    let mut tabs: Vec<DocumentTab> = Vec::with_capacity(raw.len());
    for tab in raw.iter().filter_map(parse_tab) {
        if seen.insert(tab.id()) {
            tabs.push(tab);
        }
    }
    if tabs.is_empty() {
        return None;
    }
    let active_id = object
        .get("activeId")
        .and_then(Value::as_str)
        .filter(|id| seen.contains(*id))
        .map(str::to_string);
    let mut recency: Vec<String> = Vec::new();
    if let Some(list) = object.get("recency").and_then(Value::as_array) {
        for id in list.iter().filter_map(Value::as_str) {
            if seen.contains(id) && !recency.iter().any(|kept| kept == id) {
                recency.push(id.to_string());
            }
        }
    }
    Some(SessionDocumentTabs {
        tabs,
        active_id,
        recency,
    })
}

/// A missing or non-object value is no tabs; a malformed Session entry is dropped, never the whole row.
fn parse_document_tabs(value: Option<&Value>) -> BTreeMap<String, SessionDocumentTabs> {
    let Some(object) = value.and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    object
        .iter()
        .filter(|(session_id, _)| {
            !session_id.is_empty() && session_id.len() <= MAX_SESSION_ID_BYTES
        })
        .filter_map(|(session_id, entry)| Some((session_id.clone(), parse_session_tabs(entry)?)))
        .collect()
}

/// Shared by the disk loader (malformed resets to default) and the IPC setter (`invalid-argument`).
/// Clamps width, de-duplicates ids, and repairs an out-of-range active id to the last open tab.
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
    let document_tabs = parse_document_tabs(object.get("documentTabs"));
    let chat_collapsed = object
        .get("chatCollapsed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(RightPaneState {
        open,
        width_px,
        open_panel_ids,
        active_panel_id,
        panel_order,
        document_tabs,
        chat_collapsed,
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
    /// Plain-replace setter.
    pub async fn set_right_pane(&mut self, value: RightPaneState) -> std::io::Result<Settings> {
        let next = Settings {
            right_pane: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}

#[cfg(test)]
#[path = "right_pane.test.rs"]
mod tests;
