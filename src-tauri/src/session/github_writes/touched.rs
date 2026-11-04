// Per-Conversation list of PRs and issues a Session wrote to; newest first, deduped, capped.

use serde_json::{json, Value};

use super::WriteKind;

/// The most items kept; the oldest fall off.
pub(in crate::session) const MAX_TOUCHED: usize = 50;

/// One PR or issue; `title`, `state` and `fetched_at` are filled in by the lazy state refresh.
#[derive(Debug, Clone)]
pub(in crate::session) struct TouchedItem {
    pub owner: String,
    pub name: String,
    pub kind: WriteKind,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: &'static str,
    pub last_touched_at: i64,
    pub repository_id: Option<String>,
    /// Wall-clock ms of the last finished lookup; 0 before the first.
    pub fetched_at: i64,
    pub in_flight: bool,
}

/// GitHub numbers PRs and issues from one counter per repo, so `(repo, number)` identifies an item.
#[derive(Debug, Default)]
pub(in crate::session) struct TouchedList {
    items: Vec<TouchedItem>,
}

impl TouchedList {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn items_mut(&mut self) -> &mut [TouchedItem] {
        &mut self.items
    }

    /// Adds or moves to the front; a repeat keeps what is already known and prefers the PR kind.
    pub fn touch(&mut self, owner: &str, name: &str, kind: WriteKind, number: u64, at_ms: i64) {
        let existing = self.items.iter().position(|i| {
            i.number == number
                && i.owner.eq_ignore_ascii_case(owner)
                && i.name.eq_ignore_ascii_case(name)
        });
        let mut item = match existing {
            Some(index) => self.items.remove(index),
            None => TouchedItem {
                owner: owner.to_string(),
                name: name.to_string(),
                kind,
                number,
                title: String::new(),
                url: default_url(owner, name, kind, number),
                state: "unknown",
                last_touched_at: at_ms,
                repository_id: None,
                fetched_at: 0,
                in_flight: false,
            },
        };
        if kind == WriteKind::Pr && item.kind != WriteKind::Pr {
            item.kind = kind;
            item.url = default_url(owner, name, kind, number);
        }
        item.last_touched_at = item.last_touched_at.max(at_ms);
        self.items.insert(0, item);
        self.items.truncate(MAX_TOUCHED);
    }

    /// The `TouchedRef[]` wire value, or `None` when empty so the readout key is omitted.
    pub fn to_json(&self) -> Option<Value> {
        if self.items.is_empty() {
            return None;
        }
        let refs: Vec<Value> = self
            .items
            .iter()
            .map(|i| {
                json!({
                    "ownerRepo": format!("{}/{}", i.owner, i.name),
                    "repositoryId": i.repository_id,
                    "kind": if i.kind == WriteKind::Pr { "pr" } else { "issue" },
                    "number": i.number,
                    "title": i.title,
                    "url": i.url,
                    "state": i.state,
                    "lastTouchedAt": i.last_touched_at,
                })
            })
            .collect();
        Some(Value::Array(refs))
    }
}

/// GitHub redirects `/issues/N` to `/pull/N` and back, so this is safe before the real kind is known.
fn default_url(owner: &str, name: &str, kind: WriteKind, number: u64) -> String {
    let segment = if kind == WriteKind::Pr {
        "pull"
    } else {
        "issues"
    };
    format!("https://github.com/{owner}/{name}/{segment}/{number}")
}
