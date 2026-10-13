// Chat attachment IPC channels (lane R4, issue #787): image caps (#771) and image-only send
// (#744), the attachment-handling sibling of `ipc/chat.rs`'s own send path. Pre-declared so lane
// R4 is the only lane that ever edits this file (issue #784, "Pre-declare per-lane Rust files");
// no channel is registered yet.

use super::Dispatcher;

pub fn register(_d: &mut Dispatcher) {
    // No channels registered yet; lane R4 (#787) adds its own `d.register(...)` calls here.
}
