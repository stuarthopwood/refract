// Agent start queue (issue #512: start-progress banner, staged wait) (lane R3, issue #786).
// Pre-declared so lane R3 is the only lane that ever edits this file (issue #784, "Pre-declare
// per-lane Rust files").
//
// `on_frame` is the one extension point `agent.rs`'s own `handle_frame` calls for every decoded
// frame (one call per lane module, cheap and allocation-free as a no-op); lane R3 adds its start
// queue behaviour inside this function, never inside `agent.rs` itself.

use serde_json::Value;

use super::agent::SessionAgent;

pub(crate) fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane R3 (#786) lands.
}
