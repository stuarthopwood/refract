use super::*;

#[test]
fn manager_is_one_shared_instance() {
    assert!(std::ptr::eq(manager(), manager()));
}

#[test]
fn lifecycle_hooks_are_safe_with_no_tabs() {
    manager().close_session("no-such-session");
    manager().shutdown_all();
}
