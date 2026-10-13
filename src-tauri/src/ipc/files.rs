// File preview and path-containment IPC channels (lane R7, issue #790), the `files.*` sibling of
// `ipc/file_explorer.rs`'s own tree/watcher channels. Pre-declared so lane R7 is the only lane
// that ever edits this file (issue #784, "Pre-declare per-lane Rust files"); no channel is
// registered yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R7 (#790) adds its own `d.register(...)` calls here.
}
