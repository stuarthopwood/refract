// Theme IPC channels (lane R8, issue #791): theme get/set, alongside this lane's generic
// `omp config` (#691) and native menu work in `omp/config.rs`/`shell/menu.rs`. Pre-declared so
// lane R8 is the only lane that ever edits this file (issue #784, "Pre-declare per-lane Rust
// files"); no channel is registered yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R8 (#791) adds its own `d.register(...)` calls here.
}
