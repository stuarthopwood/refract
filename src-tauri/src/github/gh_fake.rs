// Test-only stand-in for the `gh` process. It is thread-local, so it is only visible to a
// current-thread runtime (what `#[tokio::test]` gives); a test never leaks its fake to another.
use std::cell::RefCell;
use std::rc::Rc;

use super::gh::GhRawResult;

type Handler = Rc<dyn Fn(&[String]) -> GhRawResult>;

thread_local! {
    static HANDLER: RefCell<Option<Handler>> = const { RefCell::new(None) };
}

/// Removes the fake when dropped, so a panicking test cannot leave it installed.
pub(crate) struct FakeGhGuard;

impl Drop for FakeGhGuard {
    fn drop(&mut self) {
        HANDLER.with(|slot| *slot.borrow_mut() = None);
    }
}

/// Routes every `gh_raw` call on this thread to `handler` until the guard drops.
pub(crate) fn install(handler: impl Fn(&[String]) -> GhRawResult + 'static) -> FakeGhGuard {
    HANDLER.with(|slot| *slot.borrow_mut() = Some(Rc::new(handler)));
    FakeGhGuard
}

pub(super) fn is_active() -> bool {
    HANDLER.with(|slot| slot.borrow().is_some())
}

pub(super) fn run(args: &[&str]) -> Option<GhRawResult> {
    let handler = HANDLER.with(|slot| slot.borrow().clone())?;
    let owned: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    Some(handler(&owned))
}

pub(crate) fn success(stdout: impl Into<String>) -> GhRawResult {
    GhRawResult {
        stdout: stdout.into(),
        stderr: String::new(),
        code: 0,
        timed_out: false,
    }
}

pub(crate) fn failure(stderr: impl Into<String>) -> GhRawResult {
    GhRawResult {
        stdout: String::new(),
        stderr: stderr.into(),
        code: 1,
        timed_out: false,
    }
}

pub(crate) fn timeout() -> GhRawResult {
    GhRawResult {
        stdout: String::new(),
        stderr: String::new(),
        code: 1,
        timed_out: true,
    }
}
