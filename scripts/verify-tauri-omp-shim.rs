// PATH shim for the recorded-frame fake `omp` (issue #795 part 1/2, R12a). Compiled on demand by
// scripts/verify-tauri.mjs (`rustc --edition 2021 -O verify-tauri-omp-shim.rs -o <scratch>/omp.exe`,
// a single-file build with no Cargo project and no dependency on the shared CARGO_TARGET_DIR) and
// placed first on PATH for the spawned dev instance, so `which::which_global("omp")`
// (src-tauri/src/process/executables.rs) resolves to this binary instead of the real one.
//
// Why a native shim and not a `.cmd`/`.bat` file: `std::process::Command` (what
// `omp::process::OmpProcess` and the readiness probe both use) does not reliably execute a batch
// file directly on Windows without an explicit `cmd /c` wrapper, and resolving `omp` to anything
// other than a real executable would otherwise need a Rust-side code change this lane does not
// own. A tiny native exe sidesteps that: `CreateProcess` runs it exactly like the real `omp.exe`,
// and `Stdio::inherit()` here passes the three pipe handles `OmpProcess::connect` created straight
// through to the Node process underneath, unchanged.
//
// `REFRACT_FAKE_OMP_SCRIPT` (absolute path to verify-tauri-fake-omp.mjs) and
// `REFRACT_FAKE_OMP_NODE` (the node executable to run it with, defaults to `node` on PATH) are
// set by the harness on the dev process's own environment before this shim is ever reached.

use std::env;
use std::process::{Command, Stdio};

fn main() {
    let script = env::var("REFRACT_FAKE_OMP_SCRIPT").unwrap_or_else(|_| {
        eprintln!("verify-tauri-omp-shim: REFRACT_FAKE_OMP_SCRIPT is not set");
        std::process::exit(1);
    });
    let node = env::var("REFRACT_FAKE_OMP_NODE").unwrap_or_else(|_| "node".to_string());
    let args: Vec<String> = env::args().skip(1).collect();

    let status = Command::new(&node)
        .arg(&script)
        .args(&args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    match status {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(err) => {
            eprintln!("verify-tauri-omp-shim: failed to spawn {node} {script}: {err}");
            std::process::exit(1);
        }
    }
}
