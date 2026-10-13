// Entry point for the EXPERIMENTAL Tauri/Rust build of Refract (issue #780, spec 016). Mirrors
// `src/main/index.ts`'s role in the Electron build: the only file that runs before any window
// exists. Hides the console window in a release build, matching the Electron build's own
// windowed (non-console) packaged behaviour; a dev build keeps it, since the dispatcher's own
// stdout logging (verification step, quickstart.md) and `tauri-plugin-log`'s stdout target both
// rely on it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Constitution III / FR-005: joins the kill-on-close Job Object before any `omp` process
    // could ever be spawned (ported from `src/main/process/jobObject.ts`'s own call site in
    // `src/main/index.ts`). The scaffold stub always succeeds; a later slice's real
    // `windows-rs` implementation keeps this exact call site.
    if let Err(err) = refract_tauri_lib::process::job_object::join_kill_on_close() {
        eprintln!("refract-tauri: failed to join kill-on-close Job Object: {err}");
    }

    refract_tauri_lib::run();
}
