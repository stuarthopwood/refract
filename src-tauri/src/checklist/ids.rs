// Checklist ids (`p1`, `p2`, ...) and item ids (`i1`, `i2`, ...). The counters are persisted and only
// rise: deriving the next id from the current list would reuse the highest removed id.

use super::model::{Checklist, ChecklistFile};

/// Hands out the next checklist id and advances the persisted counter.
pub fn take_checklist_id(file: &mut ChecklistFile) -> String {
    let id = format!("p{}", file.next_checklist_seq);
    file.next_checklist_seq += 1;
    id
}

/// Hands out the next item id within a checklist and advances its counter.
pub fn take_item_id(checklist: &mut Checklist) -> String {
    let id = format!("i{}", checklist.next_item_seq);
    checklist.next_item_seq += 1;
    id
}
