// Side chat (`/btw`) and word prediction with its off switch (#772) (lane R6, issue #789).
// Pre-declared so lane R6 is the only lane that ever edits this file (issue #784, "Pre-declare
// per-lane Rust files"); the IPC-facing sibling is `ipc/side_chat.rs`.
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame (one call per lane module, cheap and allocation-free as a no-op); lane R6 adds
// its side chat behaviour inside this function, never inside any file under `session/agent/`.

use serde_json::Value;

use super::agent::SessionAgent;

/// Lane R6's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_side_chat_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    // Lane R6 adds fields here when it lands (#789). Empty until then.
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane R6 (#789) lands.
}
