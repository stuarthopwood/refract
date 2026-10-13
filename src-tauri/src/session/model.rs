// Model roles (lane RM, issues #454, #740, #741, #762, #766, #760): `set_model`, `cycle_model`,
// role records, pinning, `/switch`, `/model`, `/models`, `/role`, Ctrl+R, `/plan`, custom
// commands. Pre-declared so lane RM is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// `on_frame` is the one extension point `agent.rs`'s own `handle_frame` calls for every decoded
// frame (one call per lane module, cheap and allocation-free as a no-op); lane RM adds its model
// behaviour inside this function, never inside `agent.rs` itself.

use serde_json::Value;

use super::agent::SessionAgent;

pub(crate) fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane RM (#454, #740, #741, #762, #766, #760) lands.
}
