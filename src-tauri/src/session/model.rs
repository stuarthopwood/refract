// Model roles (lane RM, issues #454, #740, #741, #762, #766, #760): `set_model`, `cycle_model`,
// role records, pinning, `/switch`, `/model`, `/models`, `/role`, Ctrl+R, `/plan`, custom
// commands. Pre-declared so lane RM is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane RM adds its model behaviour inside these functions,
// never inside any file under `session/agent/`.

use serde_json::Value;

use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

/// Lane RM's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_model_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    // Lane RM adds fields here when it lands (#454, #740, #741, #762, #766, #760). Empty until
    // then.
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op until lane RM (#454, #740, #741, #762, #766, #760) lands.
}

pub(super) async fn on_exit(_agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // No-op until lane RM (#454, #740, #741, #762, #766, #760) lands.
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op until lane RM (#454, #740, #741, #762, #766, #760) lands.
}
