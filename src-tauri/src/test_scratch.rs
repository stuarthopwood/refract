// The short prefix keeps nested git worktree paths under git's Windows path limit.
// Each scratch dir is a `TempDir` held by the test's thread, so it is removed when the test ends
// (pass, fail or panic). libtest runs every test on its own thread; `--test-threads=1` runs them
// on the main thread, where the dirs live until the process exits.
use std::cell::RefCell;
use std::path::{Path, PathBuf};

thread_local! {
    static HELD: RefCell<Vec<tempfile::TempDir>> = const { RefCell::new(Vec::new()) };
}

/// Returns `name` inside a fresh `TempDir` owned by the current thread; the caller creates it.
pub(crate) fn path(name: impl AsRef<Path>) -> PathBuf {
    let dir = tempfile::Builder::new()
        .prefix("rf-")
        .rand_bytes(3)
        .tempdir()
        .expect("create scratch dir");
    let joined = dir.path().join(name);
    HELD.with(|held| held.borrow_mut().push(dir));
    joined
}
