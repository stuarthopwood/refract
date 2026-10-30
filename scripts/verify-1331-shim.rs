// Native launcher for scripts/verify-tauri-1331.mjs. Windows `CreateProcess` only auto-appends
// `.exe`, so a fake `omp` or `gh` must be a real executable. This one re-execs Node against the
// sibling `<exe stem>-logic.cjs` (generated per run), forwarding argv, stdio and the exit code.
use std::env;
use std::process::{exit, Command};

fn main() {
    let exe = env::current_exe().expect("verify-1331 shim: current_exe failed");
    let stem = exe.file_stem().expect("verify-1331 shim: no file stem").to_string_lossy().to_string();
    let script = exe.with_file_name(format!("{stem}-logic.cjs"));
    let args: Vec<String> = env::args().skip(1).collect();
    let status = Command::new("node")
        .arg(&script)
        .args(&args)
        .status()
        .expect("verify-1331 shim: failed to spawn node");
    exit(status.code().unwrap_or(1));
}
