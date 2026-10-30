// Native `gh.exe` shim for `scripts/verify-1121-pr-polish.mjs`'s fake GitHub CLI: Windows process creation only auto-appends
// `.exe`, never PATHEXT, so a `.cmd` shim is invisible to the app. Re-execs Node on the sibling `fake-gh-logic.cjs`.
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
