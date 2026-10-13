// Side chat (`/btw`) IPC channels (lane R6, issue #789), the IPC-facing sibling of
// `session/side_chat.rs`'s own frame handling. Pre-declared so lane R6 is the only lane that
// ever edits this file (issue #784, "Pre-declare per-lane Rust files"); no channel is registered
// yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R6 (#789) adds its own `d.register(...)` calls here.
}
