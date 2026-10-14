// Unit tests for `ipc::model` (lane RM, issues #454, #740, #741, #762, #766): `map_model_error`'s
// direct passthrough. `#[path]`-loaded sibling of `model.rs` (excluded from `check:file-size` by
// its own `_tests.rs` name). The handler functions themselves all need a live `SessionAgent`
// with a running process to do anything past argument validation, and no `AppState`/`OmpProcess`
// test fixture exists anywhere in this build (`ipc::chat`'s own test suite is pure-helper-only
// for the same reason) -- covered instead by this lane's own live CDP check.

use super::*;

#[test]
fn map_model_error_passes_code_and_message_through_unchanged() {
    let err = crate::session::AgentError::new("not-idle", "Switch the model after the current turn.");
    let ipc_err = map_model_error(err);
    assert_eq!(ipc_err.code, "not-idle");
    assert_eq!(ipc_err.message, "Switch the model after the current turn.");
}
