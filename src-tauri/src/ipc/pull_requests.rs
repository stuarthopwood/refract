// GitHub pull request IPC channels (lane R9, issue #792): list/open pull requests, release
// notes, through the user's own `gh` CLI (no stored token). Pre-declared so lane R9 is the only
// lane that ever edits this file (issue #784, "Pre-declare per-lane Rust files"); no channel is
// registered yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R9 (#792) adds its own `d.register(...)` calls here.
}
