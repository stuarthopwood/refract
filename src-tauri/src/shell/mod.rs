// Window shell, chrome, notifications, single instance, window state (#623), and the Tauri
// security baseline (lane R10b, issue #793). Pre-declared so lane R10b is the only lane that ever
// edits this file (issue #784, "Pre-declare per-lane Rust files"); `menu.rs` (lane R8, #791) and
// `memory.rs` (lane R5, #788) are its sibling per-lane files, declared here so each lane only
// ever edits its own file.

pub mod memory;
pub mod menu;
