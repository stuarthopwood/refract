// Unit tests for `ipc::model` (lane RM, issues #454, #740, #741, #762, #766): `map_model_error`'s
// direct passthrough. `#[path]`-loaded sibling of `model.rs` (excluded from `check:file-size` by
// its own `_tests.rs` name).
//
// Gate-fix (tests review): this header used to claim "no AppState... test fixture exists
// anywhere in this build" -- false: `ipc::sessions_lifecycle_tests::make_state` and
// `session::manager`'s own test module both build one, and `get_or_create_agent` returns a
// never-started agent a test can drive directly (see `session::manager::tests`' own
// `apply_role_change_*` tests for #740's sweep rules, exercised that way). The handler functions
// in `model.rs` themselves are still not tested AT THIS LAYER: they are thin argument-parsing
// wrappers with no logic of their own beyond what `session::model`'s own tests and the
// manager-level sweep tests already cover: validation order of the gate findings (verify-effect,
// atomic idle-check, null-safety) lives in `session::model`'s own functions, and a full
// `AppState`-driven request/response proof needs a live `SessionAgent` with a running `omp`
// process (the live CDP check, not a unit test).

use super::*;

#[test]
fn map_model_error_passes_code_and_message_through_unchanged() {
    let err =
        crate::session::AgentError::new("not-idle", "Switch the model after the current turn.");
    let ipc_err = map_model_error(err);
    assert_eq!(ipc_err.code, "not-idle");
    assert_eq!(ipc_err.message, "Switch the model after the current turn.");
}
