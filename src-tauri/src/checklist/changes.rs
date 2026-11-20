// The change record: what the developer changed since the agent last confirmed a
// `seenRev`. Nothing is logged separately; entries are read back from each item's
// `lastDeveloperOps` and from `removed`, and the watermark only moves when the agent quotes one.

use super::model::{Actor, Checklist, ItemStatus, OpKind, MAX_USER_CHANGES};

/// Names the op and the changed fields only, never new text or a value, because it reaches the
/// agent's prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserChange {
    pub rev: u64,
    pub item_id: String,
    pub op: OpKind,
    /// The item's stored status when the result is built, not at the developer's op.
    pub status: Option<ItemStatus>,
    pub value_bytes: Option<usize>,
    pub fields: Vec<String>,
}

/// The developer edits an agent has not yet seen, plus whether more remain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSet {
    pub changes: Vec<UserChange>,
    pub more: bool,
    /// What the agent should quote next: `rev` when everything fit, else just short of the first
    /// entry left out.
    pub seen_rev: u64,
}

/// Pure: reading never moves the watermark, so a lost result returns the same changes again.
pub fn user_changes(list: &Checklist) -> ChangeSet {
    let seen = list.agent_seen_rev;
    let mut all = Vec::new();
    for item in &list.items {
        for record in item.last_developer_ops.iter().filter(|r| r.rev > seen) {
            all.push(UserChange {
                rev: record.rev,
                item_id: item.id.clone(),
                op: record.kind,
                status: (record.kind == OpKind::SetStatus).then_some(item.status),
                value_bytes: (record.kind == OpKind::SetValue)
                    .then(|| item.value.as_ref().map_or(0, String::len)),
                fields: record.fields.clone(),
            });
        }
    }
    for entry in list
        .removed
        .iter()
        .filter(|r| r.by == Actor::Developer && r.rev > seen)
    {
        all.push(UserChange {
            rev: entry.rev,
            item_id: entry.id.clone(),
            op: OpKind::Remove,
            status: None,
            value_bytes: None,
            fields: Vec::new(),
        });
    }
    all.sort_by_key(|c| c.rev);

    let more = all.len() > MAX_USER_CHANGES;
    let first_left_out = all.get(MAX_USER_CHANGES).map(|c| c.rev);
    all.truncate(MAX_USER_CHANGES);
    let seen_rev = match (more, all.last(), first_left_out) {
        // Two entries on one rev cannot be split by a watermark, so stop below it and re-deliver.
        (true, Some(last), Some(next)) if next > last.rev => last.rev,
        (true, Some(last), _) => last.rev.saturating_sub(1),
        _ => list.rev,
    };
    ChangeSet {
        changes: all,
        more,
        seen_rev,
    }
}

/// Raises `agentSeenRev` to the `seenRev` the agent quoted, clamped to what Rust issued and to
/// `rev`, so quoting `rev` after an overflow cannot skip undelivered changes. Call it on the
/// checklist the call's own op produced, so both reach the file in one write.
pub fn acknowledge(list: &mut Checklist, quoted: Option<u64>) {
    if let Some(quoted) = quoted {
        let reach = quoted.min(list.issued_seen_rev).min(list.rev);
        list.agent_seen_rev = list.agent_seen_rev.max(reach);
    }
    let seen = list.agent_seen_rev;
    list.removed.retain(|r| r.rev > seen);
}

/// Records the `seenRev` a result carries; written before the result is sent.
pub fn issue_seen_rev(list: &mut Checklist, seen_rev: u64) {
    list.issued_seen_rev = list.issued_seen_rev.max(seen_rev);
}

#[cfg(test)]
#[path = "changes.test.rs"]
mod tests;
