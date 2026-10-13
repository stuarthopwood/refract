// Subagent summaries from `get_subagents` (#712, #489) (lane R5, issue #788). Pre-declared so
// lane R5 is the only lane that ever edits this file (issue #784, "Pre-declare per-lane Rust
// files").
//
// `on_frame` is the one extension point `agent.rs`'s own `handle_frame` calls for every decoded
// frame (one call per lane module, cheap and allocation-free as a no-op); lane R5 adds its
// subagent behaviour inside this function, never inside `agent.rs` itself.

use serde_json::Value;

use super::agent::SessionAgent;

pub(crate) fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane R5 (#788) lands.
}
