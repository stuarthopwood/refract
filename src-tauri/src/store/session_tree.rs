// Pure Session-tree rules over registry rows (#1859): depth, live children, descendants, re-parenting.
// A parent id missing from the registry counts as no parent everywhere (spec 131 decision 26).

use std::collections::HashSet;

use super::registry::Session;

/// A root Session is depth 1; a Session at this depth cannot take children.
pub const MAX_DEPTH: usize = 3;
/// Live (non-archived) children one parent may have; stopped and hidden children count.
pub const MAX_LIVE_CHILDREN: usize = 4;

/// Why a Session may not take a new or changed parent; the tools map these to error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeError {
    InvalidParent,
    DepthLimit,
    ChildLimit,
}

fn find<'a>(sessions: &'a [Session], id: &str) -> Option<&'a Session> {
    sessions.iter().find(|s| s.id == id)
}

/// Depth counted up the registry parent chain, root = 1. A cyclic chain counts as a root so bad
/// data can neither loop nor push a Session past the limit.
pub fn depth_of(sessions: &[Session], id: &str) -> usize {
    let mut seen = HashSet::new();
    let mut depth = 1;
    let mut current = find(sessions, id);
    while let Some(session) = current {
        if !seen.insert(session.id.as_str()) {
            break;
        }
        current = session
            .parent_session_id
            .as_deref()
            .and_then(|parent| find(sessions, parent));
        if current.is_some() {
            depth += 1;
        }
    }
    depth
}

/// Children of `parent_id` that are not archived.
pub fn live_children<'a>(
    sessions: &'a [Session],
    parent_id: &'a str,
) -> impl Iterator<Item = &'a Session> + 'a {
    sessions.iter().filter(move |s| {
        s.parent_session_id.as_deref() == Some(parent_id)
    })
}

/// Every Session below `id` (children, their children, ...), excluding `id`; archived ones
/// included, because archiving keeps the link.
pub fn descendants(sessions: &[Session], id: &str) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::from([id]);
    let mut found = Vec::new();
    let mut frontier = vec![id];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for parent in frontier {
            for child in sessions
                .iter()
                .filter(|s| s.parent_session_id.as_deref() == Some(parent))
            {
                if seen.insert(child.id.as_str()) {
                    found.push(child.id.clone());
                    next.push(child.id.as_str());
                }
            }
        }
        frontier = next;
    }
    found
}

/// True when `id` is `root_id` itself or one of its descendants (the caller's own tree).
pub fn in_tree(sessions: &[Session], root_id: &str, id: &str) -> bool {
    id == root_id || descendants(sessions, root_id).iter().any(|d| d == id)
}

/// Levels in the subtree rooted at `id`, counting `id` itself as 1.
fn subtree_height(sessions: &[Session], id: &str) -> usize {
    let mut seen: HashSet<&str> = HashSet::from([id]);
    let mut frontier = vec![id];
    let mut height = 0;
    while !frontier.is_empty() {
        height += 1;
        let mut next = Vec::new();
        for parent in frontier {
            for child in sessions
                .iter()
                .filter(|s| s.parent_session_id.as_deref() == Some(parent))
            {
                if seen.insert(child.id.as_str()) {
                    next.push(child.id.as_str());
                }
            }
        }
        frontier = next;
    }
    height
}

/// Checks that `parent_id` may take a child. `child_id` is `None` for a Session about to be
/// created and the moved Session's id for a re-parent. Order: self or descendant, depth, width.
pub fn validate_parent(
    sessions: &[Session],
    child_id: Option<&str>,
    parent_id: &str,
) -> Result<(), TreeError> {
    let child_live = match child_id {
        Some(id) => {
            if id == parent_id {
                return Err(TreeError::InvalidParent);
            }
            true
        }
        None => true,
    };
    let moved_height = child_id.map_or(1, |id| subtree_height(sessions, id));
    if depth_of(sessions, parent_id) + moved_height > MAX_DEPTH {
        return Err(TreeError::DepthLimit);
    }
    // A child already under this parent is not counted twice.
    let siblings = live_children(sessions, parent_id)
        .count();
    if siblings + usize::from(child_live) > MAX_LIVE_CHILDREN {
        return Err(TreeError::ChildLimit);
    }
    Ok(())
}

#[cfg(test)]
#[path = "session_tree.test.rs"]
mod tests;
