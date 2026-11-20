// The two notice lines a Checklist adds to the agent's next prompt. They are injected unescaped,
// so they carry checklist and item ids, op names and counts only, never a title, text or value.

use super::changes::user_changes;
use super::model::{ChecklistFile, ItemStatus, OpKind};

fn op_word(op: OpKind, status: Option<ItemStatus>) -> &'static str {
    match op {
        OpKind::Add => "add",
        OpKind::Edit => "edit",
        OpKind::Move => "move",
        OpKind::Remove => "remove",
        OpKind::SetStatus if status == Some(ItemStatus::Complete) => "tick",
        OpKind::SetStatus => "status",
        OpKind::SetValue => "value",
    }
}

/// `None` when the agent has seen every developer change, so a seen checklist adds no line.
pub fn checklist_hint(file: &ChecklistFile) -> Option<String> {
    let list = file.active.as_ref()?;
    let set = user_changes(list);
    if set.changes.is_empty() {
        return None;
    }
    let changes: Vec<String> = set
        .changes
        .iter()
        .map(|c| format!("{} {}", op_word(c.op, c.status), c.item_id))
        .collect();
    Some(format!(
        "Checklist {} changed by the developer after rev {}: {}. Call refract_checklist get.",
        list.id,
        list.agent_seen_rev,
        changes.join(", ")
    ))
}

/// For a new, switched or relaunched Conversation, whose agent does not know the checklist.
pub fn conversation_line(file: &ChecklistFile) -> Option<String> {
    let list = file.active.as_ref()?;
    let done = list
        .items
        .iter()
        .filter(|i| i.status == ItemStatus::Complete)
        .count();
    Some(format!(
        "Checklist {} is active: rev {}, {} of {} items complete. Call refract_checklist get.",
        list.id,
        list.rev,
        done,
        list.items.len()
    ))
}

#[cfg(test)]
#[path = "hint.test.rs"]
mod tests;
