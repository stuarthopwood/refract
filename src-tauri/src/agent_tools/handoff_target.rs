// Which Sessions an agent may hand a Conversation action to (#1861). The call and the deferred run
// share this check, so they cannot disagree about a target.

use super::router::{ToolError, CANCELLED};
use super::sessions::NOT_FOUND;
use super::sessions_end::ancestors_of;
use super::sessions_send::INVALID_TARGET;
use super::tree_gate;
use crate::store::registry::Session;

/// How the target relates to the caller, derived from ids alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relationship {
    Own,
    Descendant,
    /// Any other Session of the caller's Project.
    Sibling,
}

impl Relationship {
    pub fn label(self) -> &'static str {
        match self {
            Relationship::Own => "The calling Session itself",
            Relationship::Descendant => "Below the calling Session",
            Relationship::Sibling => "Outside this Session's tree",
        }
    }
}

/// Why a Session cannot be the target of the caller's handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetRefusal {
    CallerGone,
    NotFound,
    PersonalAgent,
    OtherProject,
    Ancestor,
}

impl TargetRefusal {
    /// The refusal as the calling agent reads it. Another Project's Session reads as unknown.
    pub fn tool_error(self, target: &str) -> ToolError {
        let not_found = || ToolError::new(NOT_FOUND, format!("no Session has id {target}"));
        match self {
            TargetRefusal::CallerGone => {
                ToolError::new(CANCELLED, "the calling Session no longer exists")
            }
            TargetRefusal::NotFound | TargetRefusal::OtherProject => not_found(),
            TargetRefusal::PersonalAgent => ToolError::new(
                INVALID_TARGET,
                "the Personal Agent cannot be changed with this tool",
            ),
            TargetRefusal::Ancestor => ToolError::new(
                INVALID_TARGET,
                "the target is an ancestor of the calling Session; the developer can do it by hand",
            ),
        }
    }

    /// The refusal as the notice for a deferred action that no longer may run.
    pub fn settle_reason(self) -> &'static str {
        match self {
            TargetRefusal::CallerGone => "the sending Session no longer exists",
            TargetRefusal::NotFound => "the Session no longer exists",
            TargetRefusal::PersonalAgent | TargetRefusal::OtherProject => {
                "the Session is outside the sending Session's Project"
            }
            TargetRefusal::Ancestor => "the Session is now an ancestor of the sending Session",
        }
    }
}

/// The target row and its relationship to `caller`, from the rows alone.
pub fn check_target<'a>(
    sessions: &'a [Session],
    caller: &str,
    target: &str,
) -> Result<(&'a Session, Relationship), TargetRefusal> {
    let caller_row = sessions
        .iter()
        .find(|s| s.id == caller)
        .ok_or(TargetRefusal::CallerGone)?;
    let row = sessions
        .iter()
        .find(|s| s.id == target)
        .ok_or(TargetRefusal::NotFound)?;
    if row.id == caller {
        return Ok((row, Relationship::Own));
    }
    if row.is_personal() {
        return Err(TargetRefusal::PersonalAgent);
    }
    if row.repository_id != caller_row.repository_id {
        return Err(TargetRefusal::OtherProject);
    }
    if ancestors_of(sessions, caller).contains(&target) {
        return Err(TargetRefusal::Ancestor);
    }
    let relationship = if tree_gate::inside_own_tree(sessions, caller, target, None) {
        Relationship::Descendant
    } else {
        Relationship::Sibling
    };
    Ok((row, relationship))
}
