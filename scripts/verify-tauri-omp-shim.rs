// PATH shim for the fake `omp`, compiled on demand by scripts/verify-tauri.mjs so `which::which_global("omp")` resolves to it.
// A native exe, not a `.cmd`: `std::process::Command` doesn't reliably run batch files on Windows without `cmd /c`,
// and `Stdio::inherit()` passes the pipe handles from `OmpProcess::connect` straight through to the Node process.
//
// `REFRACT_FAKE_OMP_SCRIPT` (path to verify-tauri-fake-omp.mjs) and `REFRACT_FAKE_OMP_NODE` (defaults to `node`) are set by the harness.

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
