// Serialises Session-tree changes and decides own-tree reach for the create/update tools (#1859).

use tokio::sync::{Mutex, MutexGuard};

use crate::store::registry::Session;
use crate::store::session_tree::{in_tree, TreeError};

/// Held from the limit check to the registry write, so two racing calls cannot both pass a check
/// that only one of them satisfies.
static GATE: Mutex<()> = Mutex::const_new(());

pub async fn lock() -> MutexGuard<'static, ()> {
    GATE.lock().await
}

/// A caller may change only its own tree: the target and any new parent must both be in it. An
/// un-nest (`None`) is inside whenever the target is (spec 131 decision 18).
pub fn inside_own_tree(
    sessions: &[Session],
    caller: &str,
    target: &str,
    new_parent: Option<&str>,
) -> bool {
    in_tree(sessions, caller, target)
        && new_parent.is_none_or(|parent| in_tree(sessions, caller, parent))
}

pub fn error_code(error: TreeError) -> &'static str {
    match error {
        TreeError::InvalidParent => "invalid_parent",
        TreeError::DepthLimit => "depth_limit",
        TreeError::ChildLimit => "child_limit",
    }
}

#[cfg(test)]
#[path = "tree_gate.test.rs"]
mod tests;
