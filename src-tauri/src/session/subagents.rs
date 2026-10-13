// Subagent summaries from `get_subagents` (#712, #489) (lane R5, issue #788). Pre-declared so
// lane R5 is the only lane that ever edits this file (issue #784, "Pre-declare per-lane Rust
// files").
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame (one call per lane module, cheap and allocation-free as a no-op); lane R5 adds
// its subagent behaviour inside this function, never inside any file under `session/agent/`.

use serde_json::Value;

use super::agent::SessionAgent;

/// Lane R5's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_subagents_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    // Lane R5 adds fields here when it lands (#788). Empty until then.
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane R5 (#788) lands.
}
