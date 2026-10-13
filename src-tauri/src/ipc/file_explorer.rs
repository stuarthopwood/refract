// File Explorer IPC channels (lane R7, issue #790): file-tree browsing, watcher updates, and the
// `files.*` preview/path-containment pair this lane shares with `ipc/files.rs`. Pre-declared so
// lane R7 is the only lane that ever edits this file (issue #784, "Pre-declare per-lane Rust
// files"); no channel is registered yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R7 (#790) adds its own `d.register(...)` calls here.
}
