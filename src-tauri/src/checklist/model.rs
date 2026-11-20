// The Checklist wire and file model (ADR 0011). Rust is the source of truth; the key
// names are the protocol's contract and `src/shared/checklist.ts` mirrors them by hand. The golden
// fixture ties the two sides, so a key added here fails the TypeScript test until it is mirrored.

use serde::{Deserialize, Serialize};

// CAPS-BEGIN: `src/shared/checklist.test.ts` reads this block as text; keep one `pub const NAME: type = value;` per line.
/// Schema version of the on-disk checklist file.
pub const FILE_VERSION: u32 = 1;
/// Byte cap for an item's text.
pub const MAX_TEXT_BYTES: usize = 200;
/// Byte cap for a checklist title.
pub const MAX_TITLE_BYTES: usize = 120;
/// Byte cap for an item's group label.
pub const MAX_GROUP_BYTES: usize = 60;
/// Byte cap for an item's value.
pub const MAX_VALUE_BYTES: usize = 1024;
/// Byte cap for a message attached to an item.
pub const MAX_ITEM_MESSAGE_BYTES: usize = 4096;
/// Byte cap for a request id.
pub const MAX_REQUEST_ID_BYTES: usize = 64;
/// Most items one checklist may hold.
pub const MAX_ITEMS: usize = 40;
/// Most archived checklists kept per Session.
pub const MAX_ARCHIVED: usize = 5;
/// Most ops accepted in one update call.
pub const MAX_OPS: usize = 20;
/// Most send records kept before the oldest is evicted.
pub const MAX_SEND_RECORDS: usize = 500;
/// Most removed-item ids remembered for the agent's changes view.
pub const MAX_REMOVED: usize = 40;
/// Most recent request ids remembered for retries.
pub const MAX_RECENT_REQUESTS: usize = 16;
/// Most developer changes reported in one result.
pub const MAX_USER_CHANGES: usize = 20;
// CAPS-END

/// Progress state of a checklist item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Upcoming,
    Next,
    InProgress,
    Blocked,
    Complete,
}

impl ItemStatus {
    /// Every status, in display order.
    pub const ALL: [Self; 5] = [
        Self::Upcoming,
        Self::Next,
        Self::InProgress,
        Self::Blocked,
        Self::Complete,
    ];
}

/// Who an item belongs to. The agent picks it per item at `create` and `add`; it is fixed after.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemOwner {
    Agent,
    Human,
    Either,
}

impl ItemOwner {
    /// Every owner value.
    pub const ALL: [Self; 3] = [Self::Agent, Self::Human, Self::Either];
}

/// Who made a change: the agent or the developer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Agent,
    Developer,
}

/// Kind of operation applied to an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Add,
    Edit,
    Move,
    Remove,
    SetStatus,
    SetValue,
}

/// One record per op kind per item: the raw material of the agent's `userChanges`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastDeveloperOp {
    pub kind: OpKind,
    pub rev: u64,
    pub fields: Vec<String>,
}

/// One checklist entry with its status, owner, value and change stamps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub text: String,
    pub status: ItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_status: Option<ItemStatus>,
    pub owner: ItemOwner,
    pub requires_value: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_by: Option<Actor>,
    pub agent_completable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub rev: u64,
    pub status_rev: u64,
    pub created_by: Actor,
    pub updated_by: Actor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_by: Option<Actor>,
    pub edited_by_developer: bool,
    pub last_developer_ops: Vec<LastDeveloperOp>,
}

/// A retired item id. The id is never reused (the counter only rises); this list is only for the
/// `userChanges` report and `item_removed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedEntry {
    pub id: String,
    pub rev: u64,
    pub by: Actor,
}

/// A remembered request id with the revision and ids it produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRequest {
    pub request_id: String,
    pub rev: u64,
    pub added_ids: Vec<String>,
}

/// One checklist: title, items, revision and the bookkeeping that keeps agent and developer edits apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checklist {
    pub id: String,
    pub title: String,
    pub rev: u64,
    pub next_item_seq: u64,
    pub agent_seen_rev: u64,
    pub issued_seen_rev: u64,
    pub created_at: String,
    pub items: Vec<ChecklistItem>,
    pub removed: Vec<RemovedEntry>,
    pub recent_requests: Vec<RecentRequest>,
}

/// What the developer's send did with an item: complete, ask or attach a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendAction {
    Complete,
    Ask,
    Value,
}

/// Hash-only: the turn text is never stored (design "Envelope").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRecord {
    pub checklist_id: String,
    pub item_id: String,
    pub rev: u64,
    pub action: SendAction,
    pub text_hash: String,
}

/// A queued "complete this step" turn. `turn_marker` is the checklist `rev` after the item went
/// `in_progress`, which is also the item's `statusRev`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingComplete {
    pub checklist_id: String,
    pub item_id: String,
    pub turn_marker: u64,
    pub started: bool,
}

/// The per-Session file: the active checklist, the archive and the persisted counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistFile {
    pub version: u32,
    pub next_checklist_seq: u64,
    pub active: Option<Checklist>,
    /// Newest last; values are dropped when a checklist is archived.
    pub archived: Vec<Checklist>,
    pub send_records: Vec<SendRecord>,
    pub pending_complete: Vec<PendingComplete>,
}

impl ChecklistFile {
    /// An empty file with no active checklist.
    pub fn empty() -> Self {
        Self {
            version: FILE_VERSION,
            next_checklist_seq: 1,
            active: None,
            archived: Vec::new(),
            send_records: Vec::new(),
            pending_complete: Vec::new(),
        }
    }
}

impl Checklist {
    /// A new empty checklist with the given id, title and creation time.
    pub fn empty(id: String, title: String, created_at: String) -> Self {
        Self {
            id,
            title,
            rev: 0,
            next_item_seq: 1,
            agent_seen_rev: 0,
            issued_seen_rev: 0,
            created_at,
            items: Vec::new(),
            removed: Vec::new(),
            recent_requests: Vec::new(),
        }
    }
}

#[cfg(test)]
#[path = "model.test.rs"]
mod tests;
