// Serialises Session-tree changes and decides own-tree reach for the create/update tools (#1859).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::store::registry::Session;
use crate::store::session_tree::{in_tree, TreeError};

/// One gate per Project: parents are same-Project and the Session cap is per-Project, so calls in
/// different Projects cannot invalidate each other's checks.
static GATES: LazyLock<StdMutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Held from the limit check to the registry write, so two racing calls in a Project cannot both
/// pass a check that only one of them satisfies.
pub async fn lock(repository_id: &str) -> OwnedMutexGuard<()> {
    let gate = GATES
        .lock()
        .expect("gate map poisoned")
        .entry(repository_id.to_string())
        .or_default()
        .clone();
    gate.lock_owned().await
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
