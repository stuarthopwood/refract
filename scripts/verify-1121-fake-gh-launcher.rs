// Native `gh.exe` shim for `scripts/verify-1121-pr-polish.mjs`'s deterministic fake GitHub CLI.
// Windows' `CreateProcessW` (what `std::process::Command`/tokio's `Command::new("gh")` resolve
// through, same as `which::which_global` -- `src-tauri/src/github/gh.rs`'s `resolve_gh`) only
// ever auto-appends `.exe` to a bare program name; it never consults PATHEXT to find a `.cmd`/
// `.bat` the way `cmd.exe`'s own search does. A script-based shim is therefore invisible to the
// app under test -- this compiles (via `rustc`, mirroring `verify-tauri-launcher.rs`'s own
// buildLauncher pattern, no `cargo`/shared target dir involved) into a real `gh.exe` placed
// first on the launched app's PATH, and re-execs Node against the sibling `fake-gh-logic.cjs`
// (generated fresh per run with this run's own fixture data), forwarding argv, stdio and exit
// code unchanged.
use std::env;
use std::path::PathBuf;
use std::process::{exit, Command};

fn main() {
    let exe = env::current_exe().expect("verify-1121 fake gh.exe: current_exe failed");
    let dir: PathBuf = exe
        .parent()
        .expect("verify-1121 fake gh.exe: no parent dir")
        .to_path_buf();
    let script = dir.join("fake-gh-logic.cjs");
    let args: Vec<String> = env::args().skip(1).collect();
    let status = Command::new("node")
        .arg(&script)
        .args(&args)
        .status()
        .expect("verify-1121 fake gh.exe: failed to spawn node");
    exit(status.code().unwrap_or(1));
}
