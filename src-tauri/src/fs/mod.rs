// Rust port of `src/main/fs/` (file watcher, preview, path containment): the File Explorer and
// file-security slice (lane R7, issue #790, #729/#768). Owned exclusively by this lane (issue
// #784, "Pre-declare per-lane Rust files").

pub mod explorer_watch_state;
pub mod list_directory;
pub mod paths;
pub mod read_preview;
pub mod resolve;
pub mod vscode;
pub mod watch;
